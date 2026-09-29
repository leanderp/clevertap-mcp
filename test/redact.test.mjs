import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { redactPii, isPiiKey } from "../dist/redact.js";
import { CursorStore } from "../dist/cursors.js";
import { eventTools } from "../dist/tools/events.js";
import { profileTools } from "../dist/tools/profiles.js";
import { callTool, json, makeClient, mockFetch } from "./helpers.mjs";

let mock;
afterEach(() => {
  mock?.restore();
  delete process.env.CLEVERTAP_REDACT_PII;
});

// Fictional customer: every value below is invented.
const EMAIL = "ana.prueba@example.com";
const PHONE_INT = 584120000000;
const PHONE_STR = "+584120000000";
const customer = () => ({
  profile: {
    name: "Ana Prueba",
    email: EMAIL,
    phone: PHONE_INT,
    identity: EMAIL,
    all_identities: [PHONE_STR, "5758418", EMAIL],
    badKs: [EMAIL, "5758418"],
    push_token: "fcm:tokenficticio123",
    objectId: "__0123456789abcdef",
    platform: "Android",
    df: { 0: 55, 1: 111 },
    profileData: {
      buyer_email: EMAIL,
      buyer_phone: PHONE_STR,
      buyer_id: "5758418",
      nombre: "Ana",
      apellido: "Prueba",
      foto: "https://cdn.example.com/avatars/ana.jpg",
      user_birth_date: "$D_1060560000",
      "númerotélefono": PHONE_STR,
      lugardeenvio: "Casa",
      ht3_city: "Caracas",
      ht2_total_orders: 3,
      ht3_last_order_at: "$D_1790373205",
      is_email_rides_verified: "true",
      encuesta_respuesta: `Escríbanme a ${EMAIL} o al ${PHONE_STR}`,
      encuesta_bare: "llamar al 584120000000 por favor",
    },
  },
  event_props: { "CT Session Id": 1790670621, "CT Network Type": "LTE" },
  ts: 20260929043022,
});

// ── the redactor ───────────────────────────────────────────────────────────

test("contact data is removed at every depth", () => {
  const out = JSON.stringify(redactPii(customer()));
  for (const secret of [EMAIL, "Ana Prueba", "584120000000", "tokenficticio", "ana.jpg", "1060560000"]) {
    assert.ok(!out.includes(secret), `still contains ${secret}`);
  }
  assert.match(out, /\[email\]/);
  assert.match(out, /\[phone\]/);
});

test("identifiers and business data that are not contact details survive", () => {
  const { profile, event_props, ts } = redactPii(customer());
  assert.equal(profile.objectId, "__0123456789abcdef");
  assert.equal(profile.platform, "Android");
  assert.deepEqual(profile.df, { 0: 55, 1: 111 });
  assert.equal(profile.profileData.buyer_id, "5758418");
  assert.equal(profile.profileData.ht3_city, "Caracas");
  assert.equal(profile.profileData.ht2_total_orders, 3);
  // A 10-digit run inside a date marker is not a phone number, and numbers under other keys are untouched.
  assert.equal(profile.profileData.ht3_last_order_at, "$D_1790373205");
  assert.equal(event_props["CT Session Id"], 1790670621);
  assert.equal(ts, 20260929043022);
  // A flag whose name mentions e-mail carries no personal data.
  assert.equal(profile.profileData.is_email_rides_verified, "true");
  // A numeric customer id inside all_identities stays, the e-mail and phone next to it do not.
  assert.deepEqual(profile.all_identities, ["[phone]", "5758418", "[email]"]);
});

test("addresses typed into free text are caught by the value scan", () => {
  const { profile } = redactPii(customer());
  assert.equal(profile.profileData.encuesta_respuesta, "Escríbanme a [email] o al [phone]");
  assert.equal(profile.profileData.encuesta_bare, "llamar al [phone] por favor");
});

test("the input is not modified and the counts add up", () => {
  const input = customer();
  const stats = { keys: 0, values: 0 };
  redactPii(input, stats);
  assert.equal(input.profile.email, EMAIL);
  assert.ok(stats.keys >= 10 && stats.values >= 5, JSON.stringify(stats));
});

test("key detection ignores accents and case, and leaves ordinary keys alone", () => {
  for (const key of ["email", "Buyer_Email", "user_phone", "númerotélefono", "push_token", "Name", "nombre", "apellido", "foto", "dob", "badKs"]) {
    assert.equal(isPiiKey(key), true, key);
  }
  for (const key of ["objectId", "platform", "ht3_city", "message_name", "event_name", "model", "nombre_tier_fidelidad", "cashback_total_disponible", "ubicaciónhabilitada"]) {
    assert.equal(isPiiKey(key), false, key);
  }
});

// ── the tools ──────────────────────────────────────────────────────────────

const args = { event_name: "App Launched", from: "20250101", to: "20250101" };
const exportMock = () =>
  mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "CUR%2F1" })
      : json({ status: "success", records: [customer()], next_cursor: "NEXT%2F2" })
  );

test("exports are redacted by default and say so", async () => {
  mock = exportMock();
  const page = await callTool(eventTools, "clevertap_get_events", args, makeClient());
  const text = JSON.stringify(page);
  assert.ok(!text.includes(EMAIL) && !text.includes("Ana Prueba") && !text.includes("tokenficticio"));
  assert.equal(page.pii_redacted, true);
  assert.ok(page.redactions > 0);
  assert.match(page.pii_note, /include_pii/);
});

test("include_pii returns the records as CleverTap sent them, and the choice follows the handle", async () => {
  mock = exportMock();
  const client = makeClient();
  const first = await callTool(eventTools, "clevertap_get_events", { ...args, include_pii: true }, client);
  assert.equal(first.records[0].profile.email, EMAIL);
  assert.equal(first.pii_redacted, undefined);

  const second = await callTool(eventTools, "clevertap_get_events_cursor", { cursor: first.next_cursor }, client);
  assert.equal(second.records[0].profile.email, EMAIL);
});

test("a page started without include_pii stays redacted on the next pages", async () => {
  mock = exportMock();
  const client = makeClient();
  const first = await callTool(eventTools, "clevertap_get_events", args, client);
  const second = await callTool(eventTools, "clevertap_get_events_cursor", { cursor: first.next_cursor }, client);
  assert.ok(!JSON.stringify(second).includes(EMAIL));
  assert.equal(second.pii_redacted, true);
});

test("a raw cursor can never switch redaction off", async () => {
  mock = exportMock();
  const page = await callTool(eventTools, "clevertap_get_events_cursor", { cursor: "RAW%2Fcursor" }, makeClient());
  assert.ok(!JSON.stringify(page).includes(EMAIL));
  assert.equal(page.pii_redacted, true);
});

test("the server can force redaction even when include_pii is requested", async () => {
  process.env.CLEVERTAP_REDACT_PII = "always";
  mock = exportMock();
  const client = makeClient();
  const first = await callTool(eventTools, "clevertap_get_events", { ...args, include_pii: true }, client);
  assert.ok(!JSON.stringify(first).includes(EMAIL));
  assert.match(first.pii_note, /disabled on this server/);
  const second = await callTool(eventTools, "clevertap_get_events_cursor", { cursor: first.next_cursor }, client);
  assert.ok(!JSON.stringify(second).includes(EMAIL));
});

test("profiles by event are redacted too", async () => {
  mock = mockFetch((call) =>
    call.method === "POST"
      ? json({ status: "success", cursor: "PCUR" })
      : json({ status: "success", records: [{ profileData: { Email: EMAIL, Phone: PHONE_STR, ht3_city: "Caracas" }, platformInfo: [] }] })
  );
  const page = await callTool(profileTools, "clevertap_get_profiles_by_event", args, makeClient());
  const text = JSON.stringify(page);
  assert.ok(!text.includes(EMAIL) && !text.includes("584120000000"));
  assert.match(text, /Caracas/);
});

test("fetch_first_page:false keeps the include_pii choice on the handle", async () => {
  mock = exportMock();
  const client = makeClient();
  const start = await callTool(eventTools, "clevertap_get_events", { ...args, fetch_first_page: false, include_pii: true }, client);
  const page = await callTool(eventTools, "clevertap_get_events_cursor", { cursor: start.cursor }, client);
  assert.equal(page.records[0].profile.email, EMAIL);
});

test("handles remember the PII choice, raw cursors do not", () => {
  const store = new CursorStore();
  const withPii = store.put("A%2F1", true);
  const without = store.put("B%2F2");
  assert.equal(store.resolveEntry(withPii).includePii, true);
  assert.equal(store.resolveEntry(without).includePii, false);
  assert.deepEqual(store.resolveEntry("RAW"), { cursor: "RAW", includePii: false });
});
