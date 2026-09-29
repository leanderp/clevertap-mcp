import { CleverTapToolError } from "./errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  from: Date;
  to: Date;
  /** Inclusive number of days. */
  days: number;
}

export interface RangeRules {
  /** Reject ranges longer than this many days (inclusive). */
  maxDays?: number;
  /** Reject dates after today (one day of slack for timezone differences). */
  noFuture?: boolean;
  /** Overridable clock, for tests. */
  now?: Date;
}

/** Parses a YYYYMMDD string into a UTC date, rejecting impossible dates such as 20260231. */
export function parseYmd(value: string, field: string): Date {
  if (!/^\d{8}$/.test(value)) {
    throw new CleverTapToolError(`"${field}" must be a date in YYYYMMDD format (got "${value}").`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CleverTapToolError(`"${field}" is not a real calendar date (got "${value}").`);
  }
  return date;
}

export function formatYmd(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function validateRange(from: string, to: string, rules: RangeRules = {}): DateRange {
  const start = parseYmd(from, "from");
  const end = parseYmd(to, "to");
  if (start.getTime() > end.getTime()) {
    throw new CleverTapToolError(`"from" (${from}) is after "to" (${to}).`, {
      hints: ["Swap the dates: from must be less than or equal to to."],
    });
  }
  if (rules.noFuture) {
    const limit = (rules.now ?? new Date()).getTime() + DAY_MS;
    if (end.getTime() > limit) {
      throw new CleverTapToolError(`"to" (${to}) is in the future.`, {
        hints: ["Use today or an earlier date for \"to\"."],
      });
    }
  }
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (rules.maxDays !== undefined && days > rules.maxDays) {
    throw new CleverTapToolError(
      `The range ${from}-${to} spans ${days} days; this endpoint accepts at most ${rules.maxDays}.`,
      { hints: [`Split the range into pieces of at most ${rules.maxDays} days and call once per piece.`] }
    );
  }
  return { from: start, to: end, days };
}

/** Splits an inclusive range into consecutive windows of at most `windowDays` days. */
export function splitRange(range: DateRange, windowDays: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  let cursor = range.from.getTime();
  const last = range.to.getTime();
  while (cursor <= last) {
    const windowEnd = Math.min(cursor + (windowDays - 1) * DAY_MS, last);
    windows.push({ from: formatYmd(new Date(cursor)), to: formatYmd(new Date(windowEnd)) });
    cursor = windowEnd + DAY_MS;
  }
  return windows;
}
