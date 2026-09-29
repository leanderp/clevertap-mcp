import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eventTools } from "../dist/tools/events.js";
import { profileTools } from "../dist/tools/profiles.js";
import { reportTools } from "../dist/tools/reports.js";
import { genericTools } from "../dist/tools/generic.js";
import { formatError, CleverTapToolError } from "../dist/errors.js";
import { callTool, json, makeClient, mockFetch } from "./helpers.mjs";

let mock;
afterEach(() => mock?.restore());

// ── reports ────────────────────────────────────────────────────────────────

test("uninstall report asks for the App Uninstalled event", async () => {
  mock = mockFetch(() => json({ status: "success", daily: {} }));
  await callTool(reportTools, "clevertap_get_uninstall_report", { from: "20260922", to: "20260928" }, makeClient());
  assert.equal(mock.calls[0].body.event_name, "App Uninstalled");
});

test("top property count only accepts top_n between 1 and 100", () => {
  const tool = reportTools.find((t) => t.name === "clevertap_get_top_property_count");
  const withTopN = (top_n) => ({
    event_name: "App Launched",
    from: "20260922",
    to: "20260928",
    groups: { g: { property_type: "geo_fields", name: "city", top_n } },
  });
  assert.equal(tool.inputSchema.safeParse(withTopN(100)).success, true);
  assert.equal(tool.inputSchema.safeParse(withTopN(101)).success, false);
  assert.equal(tool.inputSchema.safeParse(withTopN(0)).success, false);
});

test("event trend enforces the one-year range and the 5-group limit", async () => {
  const tool = reportTools.find((t) => t.name === "clevertap_get_event_trend");
  const groups = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, { trend_type: "daily" }]));
  assert.equal(tool.inputSchema.safeParse({ event_name: "e", from: "20260101", to: "20260102", groups: groups(6) }).success, false);

  mock = mockFetch(() => json({ status: "success" }));
  await assert.rejects(
    callTool(reportTools, "clevertap_get_event_trend", { event_name: "e", from: "20240101", to: "20260101", groups: groups(1) }, makeClient()),
    /at most 366/
  );
  assert.equal(mock.calls.length, 0);
});

const messageArgs = { from: "20260101", to: "20260220" };
const oneMessagePerCall = (call, index) =>
  json({ status: "success", total_results: 1, messages: [{ "message id": index + 1, message_name: `m${index}` }] });

test("message report splits a long range into 14-day slices and merges them", async () => {
  mock = mockFetch(oneMessagePerCall);
  const result = await callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient({ budgetMs: 600_000 }));

  assert.deepEqual(
    mock.calls.map((c) => [c.body.from, c.body.to]),
    [
      ["20260101", "20260114"],
      ["20260115", "20260128"],
      ["20260129", "20260211"],
      ["20260212", "20260220"],
    ]
  );
  assert.equal(typeof mock.calls[0].body.from, "string");
  assert.equal(result.total_results, 4);
  assert.equal(result.complete, true);
  assert.equal(result.next_actions, undefined);
});

test("message report never counts the same campaign twice", async () => {
  mock = mockFetch(() => json({ status: "success", messages: [{ "message id": 7 }] }));
  const result = await callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient({ budgetMs: 600_000 }));
  assert.equal(result.total_results, 1);
});

test("message report pages its output with limit/offset and says how to continue", async () => {
  mock = mockFetch(oneMessagePerCall);
  const result = await callTool(
    reportTools,
    "clevertap_get_message_report",
    { ...messageArgs, limit: 2, channel: ["push"] },
    makeClient({ budgetMs: 600_000 })
  );
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.next_actions[0].args, {
    channel: ["push"],
    from: "20260101",
    to: "20260220",
    limit: 2,
    offset: 2,
  });
  assert.deepEqual(mock.calls[0].body.channel, ["push"]);
});

test("message report that runs out of time returns what it has plus the remaining range", async () => {
  mock = mockFetch(oneMessagePerCall);
  const result = await callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient({ budgetMs: 1000 }));
  assert.equal(mock.calls.length, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.covered_range, { from: "20260101", to: "20260114" });
  assert.deepEqual(result.remaining_range, { from: "20260115", to: "20260220" });
  assert.deepEqual(result.next_actions[0].args, { from: "20260115", to: "20260220", limit: 100 });
});

test("message report surfaces a hard error from a later slice instead of hiding it", async () => {
  mock = mockFetch((_call, index) =>
    index === 0
      ? json({ status: "success", messages: [{ "message id": 1 }] })
      : json({ status: "fail", error: "Invalid Credentials", code: 401 }, 401)
  );
  await assert.rejects(
    callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient({ budgetMs: 600_000 })),
    /401/
  );
});

test("message report keeps what it has when a later slice fails transiently", async () => {
  mock = mockFetch((_call, index) =>
    index === 0
      ? json({ status: "success", messages: [{ "message id": 1 }] })
      : json({ status: "fail", error: "An unknown error occurred", code: 500 }, 500)
  );
  const result = await callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient({ budgetMs: 600_000 }));
  assert.equal(result.complete, false);
  assert.equal(result.total_results, 1);
  assert.match(result.stopped_because, /500/);
});

test("message report fails loudly when even the first slice fails", async () => {
  mock = mockFetch(() => json({ status: "fail", error: "An unknown error occurred", code: 500 }, 500));
  await assert.rejects(
    callTool(reportTools, "clevertap_get_message_report", messageArgs, makeClient()),
    CleverTapToolError
  );
});

test("message report rejects an inverted range without calling the API", async () => {
  mock = mockFetch(() => json({ status: "success", messages: [] }));
  await assert.rejects(
    callTool(reportTools, "clevertap_get_message_report", { from: "20260220", to: "20260101" }, makeClient()),
    /after/
  );
  assert.equal(mock.calls.length, 0);
});

// ── events / profiles pagination ───────────────────────────────────────────

// Fixed past dates: the future-date check reads the real clock, so keep them well behind it.
const eventArgs = { event_name: "App Launched", from: "20250101", to: "20250107" };

test("get_events returns the first page and the call that fetches the next one", async () => {
  mock = mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "CUR%2F1" })
      : json({ status: "success", records: [{ a: 1 }], next_cursor: "NEXT%2F2" })
  );
  const page = await callTool(eventTools, "clevertap_get_events", eventArgs, makeClient());

  // Small pages and no per-profile event summary by default: they are what keeps a page in context.
  assert.match(mock.calls[0].url, /\/events\.json\?batch_size=23&events=false$/);
  assert.equal(mock.calls[1].url, "https://us1.api.clevertap.com/1/events.json?cursor=CUR%2F1");
  assert.equal(page.records_count, 1);
  assert.equal(page.done, false);
  // The long CleverTap cursor never reaches the caller: it gets a short handle.
  assert.match(page.next_cursor, /^cur_[0-9a-f]{12}$/);
  assert.deepEqual(page.next_actions[0].args, { cursor: page.next_cursor });
  assert.equal(page.next_actions[0].tool, "clevertap_get_events_cursor");
  assert.doesNotMatch(JSON.stringify(page), /NEXT%2F2/);
});

test("get_events marks the last page as done, also for an empty range", async () => {
  mock = mockFetch((call) =>
    call.method === "POST" ? json({ status: "success", cursor: "CUR" }) : json({ status: "success" })
  );
  const page = await callTool(eventTools, "clevertap_get_events", eventArgs, makeClient());
  assert.equal(page.done, true);
  assert.deepEqual(page.records, []);
  assert.equal(page.next_actions, undefined);
});

test("get_events can return only the cursor", async () => {
  mock = mockFetch(() => json({ status: "success", cursor: "CUR" }));
  const result = await callTool(eventTools, "clevertap_get_events", { ...eventArgs, fetch_first_page: false }, makeClient());
  assert.equal(mock.calls.length, 1);
  assert.equal(result.next_actions[0].tool, "clevertap_get_events_cursor");
  assert.match(result.cursor, /^cur_[0-9a-f]{12}$/);
  assert.deepEqual(result.next_actions[0].args, { cursor: result.cursor });
});

test("get_events validates dates before calling the API and ignores the removed groups option", async () => {
  mock = mockFetch(() => json({ status: "success", cursor: "CUR" }));
  await assert.rejects(
    callTool(eventTools, "clevertap_get_events", { ...eventArgs, from: "20260231" }, makeClient()),
    /real calendar date/
  );
  assert.equal(mock.calls.length, 0);

  const tool = eventTools.find((t) => t.name === "clevertap_get_events");
  const parsed = tool.inputSchema.parse({ ...eventArgs, groups: { x: { property: "p" } } });
  assert.equal("groups" in parsed, false);
});

test("get_profiles_by_event and its cursor tool paginate the same way", async () => {
  mock = mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "PCUR" })
      : json({ status: "success", records: [{ p: 1 }, { p: 2 }], next_cursor: "PNEXT" })
  );
  const first = await callTool(profileTools, "clevertap_get_profiles_by_event", eventArgs, makeClient());
  assert.equal(first.records_count, 2);
  assert.equal(first.next_actions[0].tool, "clevertap_get_profiles_cursor");

  const next = await callTool(profileTools, "clevertap_get_profiles_cursor", { cursor: "PNEXT" }, makeClient());
  assert.equal(mock.calls[mock.calls.length - 1].url, "https://us1.api.clevertap.com/1/profiles.json?cursor=PNEXT");
  assert.equal(next.done, false);
});

// ── generic tools ──────────────────────────────────────────────────────────

test("clevertap_request tells the caller how to finish a partial query", async () => {
  mock = mockFetch(() => json({ status: "partial", req_id: 55 }));
  const result = await callTool(
    genericTools,
    "clevertap_request",
    { path: "/counts/trends.json", method: "POST", body: { event_name: "App Launched" } },
    makeClient()
  );
  assert.deepEqual(result.next_actions[0].args, { path: "/counts/trends.json", req_id: "55" });
});

test("clevertap_request still retries a 405 with the opposite method", async () => {
  mock = mockFetch((_call, index) =>
    index === 0 ? json({ status: "fail", error: "Method Not Allowed", code: 405 }, 405) : json({ status: "success", ok: true })
  );
  const result = await callTool(genericTools, "clevertap_request", { path: "/now.json", method: "GET" }, makeClient());
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(result.ok, true);
  assert.match(result._note, /405/);
});

test("clevertap_poll stops at the time budget and says how to keep going", async () => {
  mock = mockFetch(() => json({ status: "partial", req_id: 9 }));
  const result = await callTool(
    genericTools,
    "clevertap_poll",
    { path: "/counts/top.json", req_id: "9" },
    makeClient({ budgetMs: 500 })
  );
  assert.equal(result.status, "partial");
  assert.equal(result.next_actions[0].tool, "clevertap_poll");
});

// ── error formatting ───────────────────────────────────────────────────────

test("formatError lists hints, next calls and the API response", () => {
  const text = formatError(
    new CleverTapToolError("CleverTap API error 400: boom", {
      hints: ["do this"],
      nextActions: [{ tool: "clevertap_poll", args: { req_id: "1" }, why: "because" }],
      body: { status: "fail" },
    })
  );
  assert.match(text, /^Error: CleverTap API error 400: boom/);
  assert.match(text, /How to recover:\n- do this/);
  assert.match(text, /Suggested next calls:\n- clevertap_poll \{"req_id":"1"\} — because/);
  assert.match(text, /API response: \{"status":"fail"\}/);
  assert.equal(formatError(new Error("plain")), "Error: plain");
});

test("formatError never echoes the records CleverTap rejected (they carry PII)", () => {
  const text = formatError(
    new CleverTapToolError("CleverTap API error: upload failed", {
      body: {
        status: "fail",
        processed: 0,
        unprocessed: [
          {
            status: "fail",
            code: 509,
            error: "Event name mandatory",
            record: { identity: "ana@example.com", profileData: { Phone: "+5491100000000" } },
          },
        ],
      },
    })
  );
  assert.doesNotMatch(text, /ana@example\.com|\+5491100000000|identity|profileData/);
  assert.match(text, /"unprocessed_count":1/);
  assert.match(text, /Event name mandatory/);
});

test("the version announced by the server matches package.json", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, new RegExp(`version: "${pkg.version.replace(/\./g, "\\.")}"`));
});
