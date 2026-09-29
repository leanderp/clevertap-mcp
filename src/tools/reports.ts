import { z } from "zod";
import { CleverTapClient } from "../client.js";
import { splitRange, validateRange } from "../dates.js";
import { CleverTapToolError, NextAction } from "../errors.js";

const ymd = z.string().regex(/^\d{8}$/, "Use the YYYYMMDD format (e.g. '20240131')");

/** The trends endpoint accepts at most one year between from and to. */
const MAX_TREND_DAYS = 366;

// Message report tuning. The endpoint is synchronous and its latency grows with the
// range (measured against the real API: 1 day 0.7 s, 7 days 6 s, 30 days 26 s,
// 90 days 109 s), so long ranges are fetched in slices that each fit comfortably.
const MESSAGE_WINDOW_DAYS = 14;
const MESSAGE_DEFAULT_LIMIT = 100;
const MESSAGE_MAX_LIMIT = 1000;
/** Do not start another slice with less time than this left in the budget. */
const MESSAGE_MIN_WINDOW_MS = 15_000;

interface MessageReportArgs {
  from: string;
  to: string;
  channel?: string[];
  delivery?: string[];
  daily?: boolean;
  status?: string[];
  message_type?: string[];
  label?: string[];
  limit?: number;
  offset?: number;
}

export const reportTools = [
  {
    name: "clevertap_get_message_report",
    description:
      "Get delivery and engagement report for campaigns (sent, viewed, clicked, errors). Filter by channel, delivery type, label, status, and more. Campaigns are matched by their START date: one that began before the range but is still running is not included. Ranges longer than 14 days are fetched in 14-day slices; if they do not all fit in the time budget the response has complete: false, a remaining_range and next_actions that continue from there. At most 'limit' messages are returned per call (default 100); when truncated is true, repeat with the next offset from next_actions or narrow with filters.",
    inputSchema: z.object({
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format"),
      channel: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by channels: push, email, sms, browser, inapp, webhooks, whatsapp, audiences, web_pop_up, web_exit_intent, web_native_display (alias nativedisplay), web_inbox, tiktok"
        ),
      delivery: z
        .array(z.string())
        .optional()
        .describe(
          "Filter by delivery type: one_time, inaction, action, recurring, property_time, api, multiple_dates"
        ),
      daily: z
        .boolean()
        .optional()
        .describe("If true, return a day-by-day breakdown (much larger response)"),
      status: z
        .array(z.string())
        .optional()
        .describe("Filter by campaign status: scheduled, running, stopped, completed"),
      message_type: z
        .array(z.string())
        .optional()
        .describe("Filter by message type: single, ab, message_on_user_property"),
      label: z
        .array(z.string())
        .optional()
        .describe("Filter by campaign labels"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MESSAGE_MAX_LIMIT)
        .optional()
        .describe(`Max messages returned per call (default ${MESSAGE_DEFAULT_LIMIT}, max ${MESSAGE_MAX_LIMIT})`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Skip this many messages. Only reliable together with the exact from/to of the next_actions entry (the report is fetched again on every call)"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const {
        from,
        to,
        channel,
        delivery,
        daily,
        status,
        message_type,
        label,
        limit = MESSAGE_DEFAULT_LIMIT,
        offset = 0,
      } = args as MessageReportArgs;

      const range = validateRange(from, to);
      const windows = splitRange(range, MESSAGE_WINDOW_DAYS);

      const filters: Record<string, unknown> = {};
      if (channel) filters.channel = channel;
      if (delivery) filters.delivery = delivery;
      if (daily !== undefined) filters.daily = daily;
      if (status) filters.status = status;
      if (message_type) filters.message_type = message_type;
      if (label) filters.label = label;

      const deadline = client.deadline();
      const messages: unknown[] = [];
      const seen = new Set<unknown>();
      let covered = 0;
      let stoppedBecause: string | undefined;

      for (const window of windows) {
        if (covered > 0 && client.remaining(deadline) < MESSAGE_MIN_WINDOW_MS) {
          stoppedBecause = "time budget reached";
          break;
        }
        let response: { messages?: unknown };
        try {
          response = await client.post<{ messages?: unknown }>(
            "/message/report.json",
            { ...filters, from: window.from, to: window.to },
            { timeoutMs: client.remaining(deadline), retryOn429: true }
          );
        } catch (error) {
          // Hard errors (bad credentials, invalid input) must surface; only transient ones
          // (timeout, 5xx, 429) leave a partial result the caller can continue from.
          const transient = error instanceof CleverTapToolError && error.retryable;
          if (covered === 0 || !transient) throw error;
          stoppedBecause = error instanceof Error ? error.message : String(error);
          break;
        }
        const batch = Array.isArray(response.messages) ? response.messages : [];
        for (const entry of batch) {
          // Slices do not overlap (campaigns are matched by start date), but never double count.
          const id =
            typeof entry === "object" && entry !== null
              ? (entry as Record<string, unknown>)["message id"]
              : undefined;
          if (id !== undefined) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          messages.push(entry);
        }
        covered += 1;
      }

      const coveredRange = { from: windows[0].from, to: windows[covered - 1].to };
      const complete = covered === windows.length;
      const page = messages.slice(offset, offset + limit);
      const nextActions: NextAction[] = [];

      const result: Record<string, unknown> = {
        status: "success",
        total_results: messages.length,
        returned: page.length,
        offset,
        complete,
        covered_range: coveredRange,
        messages: page,
      };

      if (!complete) {
        const remaining = { from: windows[covered].from, to: windows[windows.length - 1].to };
        result.remaining_range = remaining;
        if (stoppedBecause) result.stopped_because = stoppedBecause;
        nextActions.push({
          tool: "clevertap_get_message_report",
          args: { ...filters, ...remaining, limit },
          why: "The range is larger than one call can fetch in the time budget. Fetch the remaining part.",
        });
      }
      if (offset + limit < messages.length) {
        result.truncated = true;
        nextActions.push({
          tool: "clevertap_get_message_report",
          args: { ...filters, ...coveredRange, limit, offset: offset + limit },
          why: "More messages exist in the covered range than this page holds. Repeat with the next offset, or narrow with channel/status/label filters.",
        });
      }
      if (nextActions.length > 0) result.next_actions = nextActions;
      return result;
    },
  },
  {
    name: "clevertap_get_top_property_count",
    description:
      "Get the count of the top property values for a given event (e.g. top 10 product categories viewed). Polls automatically while CleverTap computes the result; if it is not ready within the time budget the response has status 'partial' and next_actions pointing to clevertap_poll. A group whose property does not exist for this event/account fails with 'Invalid group'.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to analyze"),
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format"),
      groups: z
        .record(
          z.object({
            property_type: z
              .string()
              .describe(
                "Property category: event_properties, session_properties, profile_fields, app_fields, demographics, technographics, reachability, geo_fields"
              ),
            name: z.string().describe("Property name to group by"),
            top_n: z
              .number()
              .int()
              .min(1)
              .max(100)
              .optional()
              .describe("Number of top values to return (1-100, default 10)"),
            order: z
              .enum(["asc", "desc"])
              .optional()
              .describe("Sort order (default desc)"),
          })
        )
        .describe(
          "Groups definition. Key is a label for this group, value defines the property to analyze."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, groups } = args as {
        event_name: string;
        from: string;
        to: string;
        groups: Record<
          string,
          { property_type: string; name: string; top_n?: number; order?: string }
        >;
      };
      validateRange(from, to);
      return client.postWithPolling("/counts/top.json", {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
        groups,
      });
    },
  },
  {
    name: "clevertap_get_event_trend",
    description:
      "Get a trend of event occurrences over time (daily, weekly, or monthly). The range can span at most one year and up to 5 groups. Polls automatically while CleverTap computes the result; if it is not ready within the time budget the response has status 'partial' and next_actions pointing to clevertap_poll.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to get trend for"),
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format (at most one year after from)"),
      groups: z
        .record(
          z.object({
            trend_type: z
              .enum(["daily", "weekly", "monthly"])
              .describe("Trend granularity"),
          })
        )
        .refine((groups) => Object.keys(groups).length <= 5, {
          message: "At most 5 groups are supported per request",
        })
        .describe(
          'Trend groups (max 5). Key is a label (e.g. "daily"), value must include trend_type.'
        ),
      unique: z
        .boolean()
        .optional()
        .describe("If true, count unique users instead of total events"),
      sum_event_prop: z
        .string()
        .optional()
        .describe(
          "Sum values of this numeric event property across the trend period"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, groups, unique, sum_event_prop } = args as {
        event_name: string;
        from: string;
        to: string;
        groups: Record<string, { trend_type: string }>;
        unique?: boolean;
        sum_event_prop?: string;
      };
      validateRange(from, to, { maxDays: MAX_TREND_DAYS });

      const body: Record<string, unknown> = {
        event_name,
        from: parseInt(from),
        to: parseInt(to),
        groups,
      };
      if (unique !== undefined) body.unique = unique;
      if (sum_event_prop) body.sum_event_prop = sum_event_prop;

      return client.postWithPolling("/counts/trends.json", body);
    },
  },
  {
    name: "clevertap_get_dau",
    description:
      "Get Daily Active Users (DAU) count for a given date range (unique App Launched events). The range can span at most one year.",
    inputSchema: z.object({
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      validateRange(from, to, { maxDays: MAX_TREND_DAYS });
      return client.postWithPolling("/counts/trends.json", {
        event_name: "App Launched",
        from: parseInt(from),
        to: parseInt(to),
        unique: true,
        groups: { daily: { trend_type: "daily" } },
      });
    },
  },
  {
    name: "clevertap_get_uninstall_report",
    description:
      "Get the uninstall count trend over a date range (unique 'App Uninstalled' events). The range can span at most one year.",
    inputSchema: z.object({
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      validateRange(from, to, { maxDays: MAX_TREND_DAYS });
      // CleverTap's system event is "App Uninstalled"; plain "Uninstalled" is rejected as an invalid event.
      return client.postWithPolling("/counts/trends.json", {
        event_name: "App Uninstalled",
        from: parseInt(from),
        to: parseInt(to),
        unique: true,
        groups: { daily: { trend_type: "daily" } },
      });
    },
  },
  {
    name: "clevertap_get_real_time_counts",
    description:
      "Get the count of users who are actively using the app right now (within the last 5 minutes). Optionally includes a breakdown by user type.",
    inputSchema: z.object({
      user_type: z
        .boolean()
        .optional()
        .describe(
          "If true, includes a breakdown by user type in the response"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { user_type } = args as { user_type?: boolean };
      return client.post("/now.json", user_type ? { user_type } : {});
    },
  },
];
