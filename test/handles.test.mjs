import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CursorStore } from "../dist/cursors.js";
import { resolveProject } from "../dist/projects.js";
import { serializeResult } from "../dist/output.js";
import { CleverTapToolError } from "../dist/errors.js";
import { eventTools } from "../dist/tools/events.js";
import { profileTools } from "../dist/tools/profiles.js";
import { callTool, json, makeClient, mockFetch } from "./helpers.mjs";

let mock;
afterEach(() => mock?.restore());

// ── cursor handles ─────────────────────────────────────────────────────────

test("a handle resolves back to the exact cursor, and a raw cursor passes through", () => {
  const store = new CursorStore();
  const cursor = "AbC%2FdE%3D%3D".repeat(150);
  const handle = store.put(cursor);
  assert.match(handle, /^cur_[0-9a-f]{12}$/);
  assert.equal(store.resolve(handle), cursor);
  assert.equal(store.resolve("RAW%2Fcursor"), "RAW%2Fcursor");
});

test("the same cursor always gets the same handle", () => {
  const store = new CursorStore();
  assert.equal(store.put("X%2F1"), store.put("X%2F1"));
  assert.notEqual(store.put("X%2F1"), store.put("X%2F2"));
});

test("an unknown handle says how to restart the export", () => {
  const store = new CursorStore();
  assert.throws(
    () => store.resolve("cur_deadbeef0000"),
    (error) => {
      assert.ok(error instanceof CleverTapToolError);
      assert.match(error.message, /unknown or expired/);
      assert.ok(error.hints.some((hint) => /Restart the export/.test(hint)));
      return true;
    }
  );
});

test("handles expire after four hours, the life of an event cursor", () => {
  let now = 1_000_000;
  const store = new CursorStore(() => now);
  const handle = store.put("C%2F1");
  now += 3 * 60 * 60 * 1000;
  assert.equal(store.resolve(handle), "C%2F1");
  now += 2 * 60 * 60 * 1000;
  assert.throws(() => store.resolve(handle), /unknown or expired/);
});

test("the store is bounded: the oldest handles are evicted", () => {
  const store = new CursorStore();
  const first = store.put("cursor-0");
  for (let i = 1; i <= 500; i++) store.put(`cursor-${i}`);
  assert.throws(() => store.resolve(first), /unknown or expired/);
});

const pageMock = () =>
  mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "CUR%2F1" })
      : json({ status: "success", records: [{ n: 1 }], next_cursor: "NEXT%2F2" })
  );

test("a handle from one page works in the cursor tool, which sends the raw cursor to CleverTap", async () => {
  mock = pageMock();
  const client = makeClient();
  const first = await callTool(eventTools, "clevertap_get_events", { event_name: "App Launched", from: "20250101", to: "20250101" }, client);
  await callTool(eventTools, "clevertap_get_events_cursor", { cursor: first.next_cursor }, client);
  assert.equal(mock.calls.at(-1).url, "https://us1.api.clevertap.com/1/events.json?cursor=NEXT%2F2");
});

test("profiles use handles too", async () => {
  mock = pageMock();
  const client = makeClient();
  const first = await callTool(profileTools, "clevertap_get_profiles_by_event", { event_name: "App Launched", from: "20250101", to: "20250101" }, client);
  assert.match(first.next_cursor, /^cur_/);
  await callTool(profileTools, "clevertap_get_profiles_cursor", { cursor: first.next_cursor }, client);
  assert.equal(mock.calls.at(-1).url, "https://us1.api.clevertap.com/1/profiles.json?cursor=NEXT%2F2");
});

test("an unknown handle is rejected before calling CleverTap", async () => {
  mock = mockFetch(() => json({ status: "success" }));
  await assert.rejects(
    callTool(eventTools, "clevertap_get_events_cursor", { cursor: "cur_000000000000" }, makeClient()),
    /unknown or expired/
  );
  assert.equal(mock.calls.length, 0);
});

test("a page that is still in progress offers the handle, not the raw cursor, to retry", async () => {
  mock = mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "CUR%2F1" })
      : json({ status: "fail", error: "Request still in progress, please retry later", code: 2 })
  );
  await assert.rejects(
    callTool(eventTools, "clevertap_get_events", { event_name: "App Launched", from: "20250101", to: "20250101" }, makeClient({ budgetMs: 500 })),
    (error) => {
      assert.match(error.nextActions[0].args.cursor, /^cur_[0-9a-f]{12}$/);
      assert.doesNotMatch(JSON.stringify(error.nextActions), /CUR%2F1/);
      return true;
    }
  );
});

// ── page size and record shape ─────────────────────────────────────────────

test("the event summary can be turned back on, and page sizes are capped", async () => {
  mock = pageMock();
  await callTool(profileTools, "clevertap_get_profiles_by_event", { event_name: "e", from: "20250101", to: "20250101", include_event_summary: true, batch_size: 50 }, makeClient());
  assert.match(mock.calls[0].url, /\/profiles\.json\?batch_size=50$/);

  // CleverTap treats batch_size < 23 as "no limit" (5 returned 989 records): never send less than 23.
  mock.restore();
  mock = pageMock();
  await callTool(eventTools, "clevertap_get_events", { event_name: "e", from: "20250101", to: "20250101", batch_size: 5 }, makeClient());
  assert.match(mock.calls[0].url, /batch_size=23&events=false$/);

  const tool = eventTools.find((t) => t.name === "clevertap_get_events");
  const base = { event_name: "e", from: "20250101", to: "20250101" };
  assert.equal(tool.inputSchema.safeParse({ ...base, batch_size: 50 }).success, true);
  assert.equal(tool.inputSchema.safeParse({ ...base, batch_size: 51 }).success, false);
});

test("results are serialised compactly", () => {
  assert.equal(serializeResult({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.equal(serializeResult(undefined), "null");
});

// ── project resolution ─────────────────────────────────────────────────────

const one = new Map([["Yummy Delivery", "delivery-client"]]);
const two = new Map([["Yummy Delivery", "d"], ["Yummy Rides", "r"]]);

test("no project means the default one", () => {
  assert.deepEqual(resolveProject(one, undefined, "Yummy Delivery"), { name: "Yummy Delivery", client: "delivery-client" });
  assert.equal(resolveProject(one, "  ", "Yummy Delivery").client, "delivery-client");
});

test("a project name matches exactly or ignoring case", () => {
  assert.equal(resolveProject(two, "Yummy Rides", "Yummy Delivery").client, "r");
  assert.equal(resolveProject(two, " yummy rides ", "Yummy Delivery").client, "r");
});

test("a name that is not this account's falls back when there is only one project, with a note", () => {
  // The published schema used to tell Delivery users to send "Yummy Rides".
  const resolved = resolveProject(one, "Yummy Rides", "Yummy Delivery");
  assert.equal(resolved.client, "delivery-client");
  assert.match(resolved.note, /"Yummy Rides" is not configured.*"Yummy Delivery"/);
});

test("with several projects an unknown name is an error that lists the valid ones", () => {
  assert.throws(
    () => resolveProject(two, "Nope", "Yummy Delivery"),
    (error) => {
      assert.ok(error instanceof CleverTapToolError);
      assert.match(error.message, /Unknown project "Nope"\. Available: Yummy Delivery, Yummy Rides/);
      return true;
    }
  );
});
