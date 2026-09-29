import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYmd, splitRange, validateRange } from "../dist/dates.js";

test("parseYmd accepts real dates and rejects malformed or impossible ones", () => {
  assert.equal(parseYmd("20260228", "from").getUTCDate(), 28);
  assert.throws(() => parseYmd("2026-02-28", "from"), /YYYYMMDD/);
  assert.throws(() => parseYmd("20260231", "from"), /real calendar date/);
  assert.throws(() => parseYmd("20261301", "from"), /real calendar date/);
});

test("validateRange checks order, future dates and maximum span", () => {
  assert.equal(validateRange("20260101", "20260131").days, 31);
  assert.throws(() => validateRange("20260201", "20260101"), /after/);
  const now = new Date(Date.UTC(2026, 8, 29));
  assert.throws(() => validateRange("20260901", "20261231", { noFuture: true, now }), /future/);
  assert.doesNotThrow(() => validateRange("20260901", "20260929", { noFuture: true, now }));
  assert.throws(() => validateRange("20240101", "20260101", { maxDays: 366 }), /at most 366/);
});

test("splitRange cuts an inclusive range into consecutive windows", () => {
  const range = validateRange("20260101", "20260220");
  assert.deepEqual(splitRange(range, 14), [
    { from: "20260101", to: "20260114" },
    { from: "20260115", to: "20260128" },
    { from: "20260129", to: "20260211" },
    { from: "20260212", to: "20260220" },
  ]);
  assert.deepEqual(splitRange(validateRange("20260105", "20260105"), 14), [
    { from: "20260105", to: "20260105" },
  ]);
});
