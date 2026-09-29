import { z } from "zod";
import { CleverTapClient } from "../client.js";
import { validateRange } from "../dates.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, fetchCursorPage } from "./paging.js";

const ymd = z.string().regex(/^\d{8}$/, "Use the YYYYMMDD format (e.g. '20240131')");

export const profileTools = [
  {
    name: "clevertap_upload_profile",
    description:
      "Create or update a user profile in CleverTap. Use this to set user attributes like name, email, phone, age, gender, or custom properties. Max 1000 profiles per request.",
    inputSchema: z.object({
      identity: z
        .string()
        .describe("Unique user identity (email, phone, or custom ID)"),
      profileData: z
        .object({
          Name: z.string().optional().describe("Full name of the user"),
          Email: z.string().optional().describe("Email address"),
          Phone: z
            .string()
            .optional()
            .describe("Phone number with country code (e.g. +14155551234)"),
          Gender: z.enum(["M", "F"]).optional().describe("Gender: M or F"),
          DOB: z
            .string()
            .optional()
            .describe("Date of birth in YYYY-MM-DD format"),
          Age: z.number().optional().describe("Age of the user"),
          MSG_email: z
            .boolean()
            .optional()
            .describe("Opt-in/out for email messaging"),
          MSG_push: z
            .boolean()
            .optional()
            .describe("Opt-in/out for push notifications"),
          MSG_sms: z.boolean().optional().describe("Opt-in/out for SMS"),
          MSG_whatsapp: z
            .boolean()
            .optional()
            .describe("Opt-in/out for WhatsApp"),
        })
        .and(z.record(z.unknown()))
        .describe(
          "Profile properties to set. Standard fields + any custom properties."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity, profileData } = args as {
        identity: string;
        profileData: Record<string, unknown>;
      };

      return client.post("/upload", {
        d: [{ identity, type: "profile", profileData }],
      });
    },
  },
  {
    name: "clevertap_get_profile",
    description:
      "Retrieve a user profile from CleverTap. Provide at least one of: identity, email, or objectId (GUID).",
    inputSchema: z.object({
      identity: z
        .string()
        .optional()
        .describe("Custom user identity (email, phone, or custom ID)"),
      email: z.string().optional().describe("User email address"),
      objectId: z
        .string()
        .optional()
        .describe("CleverTap GUID (objectId)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity, email, objectId } = args as {
        identity?: string;
        email?: string;
        objectId?: string;
      };
      if (!identity && !email && !objectId) {
        throw new Error("At least one of identity, email, or objectId must be provided");
      }
      const params: Record<string, string> = {};
      if (identity) params.identity = identity;
      if (email) params.email = email;
      if (objectId) params.objectId = objectId;
      return client.get("/profile.json", params);
    },
  },
  {
    name: "clevertap_get_profiles_by_event",
    description:
      "Get the profiles of users who performed a specific event within a date range, one page at a time. Returns the first page of records plus next_cursor and next_actions: keep calling clevertap_get_profiles_cursor with next_cursor until it is absent (done: true). Profile cursors are valid for 4 days. Pass cursors exactly as returned.",
    inputSchema: z.object({
      event_name: z
        .string()
        .describe("Event name to filter profiles by. Exact and case-sensitive, e.g. 'App Launched'."),
      from: ymd.describe("Start date in YYYYMMDD format. Not in the future."),
      to: ymd.describe("End date in YYYYMMDD format. Not in the future."),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .optional()
        .describe(
          `Profiles per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}). Keep it small: each profile can be large.`
        ),
      fetch_first_page: z
        .boolean()
        .optional()
        .describe(
          "Default true: also return the first page of profiles. If false, only the cursor is returned and next_actions points to clevertap_get_profiles_cursor."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { event_name, from, to, batch_size, fetch_first_page } = args as {
        event_name: string;
        from: string;
        to: string;
        batch_size?: number;
        fetch_first_page?: boolean;
      };
      validateRange(from, to, { noFuture: true });
      const deadline = client.deadline();

      const step1 = await client.post<{ cursor?: string }>(
        "/profiles.json",
        { event_name, from: parseInt(from), to: parseInt(to) },
        { query: { batch_size: batch_size ?? DEFAULT_PAGE_SIZE }, timeoutMs: client.remaining(deadline), retryOn429: true }
      );
      const cursor = step1.cursor;
      if (!cursor) return step1;

      if (fetch_first_page === false) {
        return {
          ...step1,
          next_actions: [
            {
              tool: "clevertap_get_profiles_cursor",
              args: { cursor },
              why: "Fetch the first page. Pass the cursor exactly as returned.",
            },
          ],
        };
      }
      return fetchCursorPage(client, "/profiles.json", cursor, "clevertap_get_profiles_cursor", deadline);
    },
  },
  {
    name: "clevertap_get_profiles_cursor",
    description:
      "Fetch the next page of user profiles using the cursor / next_cursor returned by clevertap_get_profiles_by_event or by a previous call to this tool. The response includes next_cursor and next_actions until the last page (done: true). If CleverTap is still preparing the page the call retries for you; if it still is not ready, repeat it with the same cursor. A cursor keeps its position and is valid for 4 days; do not share one cursor between parallel calls.",
    inputSchema: z.object({
      cursor: z
        .string()
        .describe(
          "Cursor exactly as returned (cursor or next_cursor). It is already percent-encoded: do not decode, edit or URL-encode it."
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { cursor } = args as { cursor: string };
      return fetchCursorPage(client, "/profiles.json", cursor, "clevertap_get_profiles_cursor");
    },
  },
  {
    name: "clevertap_delete_profile",
    description:
      "Delete one or more user profiles from CleverTap. Processing occurs during non-business hours. Max 100 IDs per request.",
    inputSchema: z.object({
      identity: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Identity or array of identities to delete (email, phone, or custom ID)"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identity } = args as { identity: string | string[] };
      return client.post("/delete/profiles.json", { identity });
    },
  },
  {
    name: "clevertap_upload_device_token",
    description:
      "Upload a push notification device token and associate it with a user profile. Identified by objectId (GUID) only — not by identity or email. For Chrome web push tokens, also provide chrome_keys.",
    inputSchema: z.object({
      objectId: z
        .string()
        .describe(
          "CleverTap GUID (objectId) of the user — must be a GUID, not an identity/email"
        ),
      token_id: z.string().describe("The device token string"),
      token_type: z
        .enum(["apns", "gcm", "fcm", "wns", "mpns", "chrome"])
        .describe("Token type / push platform"),
      chrome_keys: z
        .object({
          p256dh: z.string().describe("Chrome P-256 Diffie-Hellman public key"),
          auth: z.string().describe("Chrome auth secret"),
        })
        .optional()
        .describe("Required only for chrome token_type"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { objectId, token_id, token_type, chrome_keys } = args as {
        objectId: string;
        token_id: string;
        token_type: string;
        chrome_keys?: { p256dh: string; auth: string };
      };
      const tokenData: Record<string, unknown> = { id: token_id, type: token_type };
      if (chrome_keys) tokenData.keys = chrome_keys;
      return client.post("/upload", {
        d: [{ type: "token", tokenData, objectId }],
      });
    },
  },
  {
    name: "clevertap_get_profile_count",
    description:
      "Get the count of user profiles who performed a specific event within a date range. Supports optional event property filters. Polls automatically while CleverTap computes the result; if it is not ready within the time budget the response has status 'partial' and next_actions pointing to clevertap_poll.",
    inputSchema: z.object({
      event_name: z.string().describe("Event name to filter profiles by"),
      from: ymd.describe("Start date in YYYYMMDD format"),
      to: ymd.describe("End date in YYYYMMDD format"),
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
      return client.postWithPolling("/counts/profiles.json", body);
    },
  },
  {
    name: "clevertap_demerge_profile",
    description:
      "Demerge (unmerge) user profiles that were incorrectly merged in CleverTap. Max 100 identities per request.",
    inputSchema: z.object({
      identities: z
        .union([z.string(), z.array(z.string())])
        .describe("Identity or array of identities of profiles to demerge (max 100)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { identities } = args as { identities: string | string[] };
      const identityArray = Array.isArray(identities) ? identities : [identities];
      return client.post("/demerge/profiles.json", { identities: identityArray });
    },
  },
  {
    name: "clevertap_subscribe",
    description:
      "Subscribe or unsubscribe users from a specific channel (phone, email, or WhatsApp). Max 1000 records per request.",
    inputSchema: z.object({
      subscriptions: z
        .array(
          z.object({
            type: z
              .enum(["phone", "email", "whatsapp"])
              .describe("Channel type"),
            value: z
              .string()
              .describe("Phone number (with country code) or email address"),
            status: z
              .enum(["Unsubscribe", "Resubscribe"])
              .describe("Subscription action"),
          })
        )
        .min(1)
        .describe("List of subscription changes"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { subscriptions } = args as {
        subscriptions: Array<{ type: string; value: string; status: string }>;
      };
      return client.post("/subscribe", { d: subscriptions });
    },
  },
  {
    name: "clevertap_disassociate_phone",
    description:
      "Disassociate a phone number from its user profile in CleverTap. Only works when the phone number is used as the user's primary identity. Max 1000 records per request.",
    inputSchema: z.object({
      phones: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Phone number(s) with country code to disassociate (e.g. '+14155551234')"
        ),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { phones } = args as { phones: string | string[] };
      const phoneArray = Array.isArray(phones) ? phones : [phones];
      const d = phoneArray.map((value) => ({ type: "phone", value }));
      return client.post("/disassociate", { d });
    },
  },
];

