import { z } from "zod";
import { CleverTapClient } from "../client.js";
import { validateRange } from "../dates.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, cursorOnly, exportQuery, fetchCursorPage, startCursorPage } from "./paging.js";

const ymd = z.string().regex(/^\d{8}$/, "Use the YYYYMMDD format (e.g. '20240131')");

export const eventTools = [
  {
    name: "clevertap_upload_events",
    description:
      "Upload one or more events for users to CleverTap. Use this to track actions like purchases, logins, page views, etc. Max 1000 records per call.",
    inputSchema: z.object({
      events: z
        .array(
          z.object({
            identity: z
              .string()
              .describe("Unique user identity (email, phone, or custom ID)"),
            evtName: z
              .string()
              .describe("Name of the event (e.g. 'Product Viewed')"),
            evtData: z
              .record(z.unknown())
              .optional()
              .describe("Key-value properties for the event"),
            ts: z
              .number()
              .optional()
              .describe(
                "Unix timestamp of the event. Defaults to now if omitted."
              ),
          })
        )
        .min(1)
        .describe("List of events to upload"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { events } = args as {
        events: Array<{
          identity: string;
          evtName: string;
          evtData?: Record<string, unknown>;
          ts?: number;
        }>;
      };

      const d = events.map((e) => ({
        identity: e.identity,
        type: "event",
        evtName: e.evtName,
        ...(e.evtData ? { evtData: e.evtData } : {}),
        ...(e.ts ? { ts: e.ts } : {}),
      }));

      return client.post("/upload", { d });
    },
  },
  {
    name: "clevertap_get_events",
    description:
      "Download the raw events of one event type within a date range, one page at a time. Returns the first page of records plus next_cursor and next_actions: keep calling clevertap_get_events_cursor with next_cursor until it is absent (done: true). Event cursors expire 4 hours after creation or after 1 hour of inactivity; if one expires, call this tool again. next_cursor is a short handle: pass it exactly as returned.",
    inputSchema: z.object({
      event_name: z
        .string()
        .describe("Name of the event to query. Exact and case-sensitive, e.g. 'App Launched', 'App Uninstalled'."),
      from: ymd.describe("Start date in YYYYMMDD format (e.g. '20240101'). Not in the future."),
      to: ymd.describe("End date in YYYYMMDD format (e.g. '20240131'). Not in the future."),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .optional()
        .describe(
          `Records per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}). CleverTap returns pages in multiples of 23 records and treats anything below 23 as unlimited, so values under 23 are raised to 23. Keep it small: a record is 0.4-6 KB and the page must fit in your context.`
        ),
      fetch_first_page: z
        .boolean()
        .optional()
        .describe(
          "Default true: also return the first page of records. If false, only the cursor is returned and next_actions points to clevertap_get_events_cursor."
        ),
      include_event_summary: z
        .boolean()
        .optional()
        .describe(
          "Default false. If true, every record also carries the profile's lifetime event summary (about 75% of the record size). Only enable it if you need it and keep batch_size small."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, batch_size, fetch_first_page, include_event_summary } = args as {
        event_name: string;
        from: string;
        to: string;
        batch_size?: number;
        fetch_first_page?: boolean;
        include_event_summary?: boolean;
      };
      validateRange(from, to, { noFuture: true });
      const deadline = client.deadline();

      const step1 = await client.post<{ cursor?: string }>(
        "/events.json",
        { event_name, from: parseInt(from), to: parseInt(to) },
        { query: exportQuery(batch_size, include_event_summary), timeoutMs: client.remaining(deadline), retryOn429: true }
      );
      const cursor = step1.cursor;
      if (!cursor) return step1;

      if (fetch_first_page === false) {
        return cursorOnly(step1 as { cursor?: string } & Record<string, unknown>, "clevertap_get_events_cursor");
      }
      return startCursorPage(client, "/events.json", cursor, "clevertap_get_events_cursor", deadline);
    },
  },
  {
    name: "clevertap_get_events_cursor",
    description:
      "Fetch the next page of event results using the cursor / next_cursor returned by clevertap_get_events or by a previous call to this tool. The response includes next_cursor and next_actions until the last page (done: true). If CleverTap is still preparing the page the call retries for you; if it still is not ready, repeat it with the same cursor.",
    inputSchema: z.object({
      cursor: z
        .string()
        .describe(
          "The cursor handle exactly as returned in next_cursor (a short value such as cur_1a2b3c4d5e6f). Do not edit it. If it is unknown or expired, restart the export."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { cursor } = args as { cursor: string };
      return fetchCursorPage(client, "/events.json", cursor, "clevertap_get_events_cursor");
    },
  },
  {
    name: "clevertap_get_event_count",
    description:
      "Get the total count of users who performed a specific event within a date range. Supports optional event property filters. Polls automatically while CleverTap computes the result; if it is not ready within the time budget the response has status 'partial' and next_actions pointing to clevertap_poll.",
    inputSchema: z.object({
      event_name: z.string().describe("Name of the event to count"),
      from: ymd.describe("Start date in YYYYMMDD format (e.g. '20240101')"),
      to: ymd.describe("End date in YYYYMMDD format (e.g. '20240131')"),
      event_properties: z
        .array(
          z.object({
            name: z.string().describe("Property name"),
            operator: z
              .string()
              .describe(
                "Comparison operator (equals, contains, notEquals, greaterThan, lessThan, etc.)"
              ),
            value: z
              .union([z.string(), z.number(), z.boolean()])
              .describe("Value to compare against"),
          })
        )
        .optional()
        .describe("Optional filters on event properties"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, event_properties } = args as {
        event_name: string;
        from: string;
        to: string;
        event_properties?: Array<{
          name: string;
          operator: string;
          value: string | number | boolean;
        }>;
      };
      const body: Record<string, unknown> = {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
      };
      if (event_properties) body.event_properties = event_properties;
      validateRange(from, to);
      return client.postWithPolling("/counts/events.json", body);
    },
  },
];
