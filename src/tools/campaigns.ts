import { z } from "zod";
import { CleverTapClient } from "../client.js";

export const campaignTools = [
  {
    name: "clevertap_get_campaigns",
    description:
      "List the campaigns created through the CleverTap API (clevertap_create_campaign / the Target API) that are scheduled within a date range. Returns id, name, scheduled_on, and status for each campaign. Campaigns built in the dashboard are NOT listed here: an empty result does not mean the account has no campaigns. Use clevertap_get_message_report to see all campaigns and their metrics.",
    inputSchema: z.object({
      from: z.string().describe("Start date in YYYYMMDD format"),
      to: z.string().describe("End date in YYYYMMDD format"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { from, to } = args as { from: string; to: string };
      return client.post("/targets/list.json", {
        from: parseInt(from),
        to: parseInt(to),
      });
    },
  },
  {
    name: "clevertap_get_campaign_report",
    description:
      "Get the delivery and engagement report for a specific campaign by its numeric ID.",
    inputSchema: z.object({
      id: z.number().int().describe("Campaign ID (integer)"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { id } = args as { id: number };
      return client.post("/targets/result.json", { id });
    },
  },
  {
    name: "clevertap_stop_campaign",
    description: "Stop an active running campaign by its numeric ID.",
    inputSchema: z.object({
      id: z.number().int().describe("Campaign ID (integer) to stop"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const { id } = args as { id: number };
      return client.post("/targets/stop.json", { id });
    },
  },
  {
    name: "clevertap_create_campaign",
    description:
      "Create and launch a campaign targeting a segment of users. Supports push, email, SMS, web push, in-app, and webhook channels.",
    inputSchema: z.object({
      name: z.string().describe("Campaign name"),
      target_mode: z
        .enum(["push", "email", "sms", "webpush", "in-app", "webhooks"])
        .describe("Delivery channel for the campaign"),
      when: z
        .string()
        .describe(
          'When to send: "now" for immediate delivery, or a datetime string in "YYYYMMDD HH:MM" format'
        ),
      content: z
        .object({
          title: z
            .string()
            .optional()
            .describe("Notification title (required for push/webpush)"),
          body: z.string().describe("Notification body / message text"),
          subject: z
            .string()
            .optional()
            .describe("Email subject line (for email campaigns)"),
          sender_name: z
            .string()
            .optional()
            .describe("Sender display name (for email campaigns)"),
          deepLink: z
            .string()
            .optional()
            .describe("Deep link URL (for push campaigns)"),
          imageUrl: z
            .string()
            .optional()
            .describe("Image URL (for push campaigns)"),
        })
        .describe("Campaign content / message"),
      where: z
        .object({
          event_name: z
            .string()
            .optional()
            .describe("Target users who performed this event"),
          from: z
            .string()
            .optional()
            .describe("Event from date in YYYYMMDD format"),
          to: z
            .string()
            .optional()
            .describe("Event to date in YYYYMMDD format"),
          profile_fields: z
            .array(
              z.object({
                field_name: z.string(),
                operator: z.string(),
                value: z.union([z.string(), z.number(), z.boolean()]),
              })
            )
            .optional()
            .describe("Additional profile property filters"),
        })
        .optional()
        .describe("Segment targeting criteria"),
      respect_frequency_caps: z
        .boolean()
        .optional()
        .describe("Whether to apply frequency caps (default true)"),
      estimate_only: z
        .boolean()
        .optional()
        .describe("If true, returns estimated reach without sending"),
    }),
    handler: async (client: CleverTapClient, args: unknown) => {
      const {
        name,
        target_mode,
        when,
        content,
        where,
        respect_frequency_caps,
        estimate_only,
      } = args as {
        name: string;
        target_mode: string;
        when: string;
        content: {
          title?: string;
          body: string;
          subject?: string;
          sender_name?: string;
          deepLink?: string;
          imageUrl?: string;
        };
        where?: {
          event_name?: string;
          from?: string;
          to?: string;
          profile_fields?: Array<{
            field_name: string;
            operator: string;
            value: string | number | boolean;
          }>;
        };
        respect_frequency_caps?: boolean;
        estimate_only?: boolean;
      };

      const payload: Record<string, unknown> = {
        name,
        target_mode,
        when,
        content,
      };

      if (where) {
        const whereBody: Record<string, unknown> = {};
        if (where.event_name) whereBody.event_name = where.event_name;
        if (where.from) whereBody.from = parseInt(where.from);
        if (where.to) whereBody.to = parseInt(where.to);
        if (where.profile_fields) {
          whereBody.common_profile_properties = {
            profile_fields: where.profile_fields,
          };
        }
        payload.where = whereBody;
      }

      if (respect_frequency_caps !== undefined)
        payload.respect_frequency_caps = respect_frequency_caps;
      if (estimate_only !== undefined) payload.estimate_only = estimate_only;

      return client.post("/targets/create.json", payload);
    },
  },
];

