import { CleverTapClient } from "../client.js";
import { cursorStore } from "../cursors.js";
import { NextAction } from "../errors.js";
import { PII_NOTE, RedactionStats, piiForced, redactPii } from "../redact.js";

// Small on purpose: a record is 0.4-6 KB and a page has to fit in the caller's context.
//
// CleverTap spreads a page over 23 internal shards, so batch_size is not linear (measured
// against the real API): 25 -> 23 records, 50 -> 46, but anything below 23 is treated as
// "no limit" (batch_size=5 returned 989 records, 1.4 MB) and omitting it returned 4,991.
// The smallest real page is therefore 23 records, and smaller requests are raised to it.
export const MIN_PAGE_SIZE = 23;
export const DEFAULT_PAGE_SIZE = 23;
export const MAX_PAGE_SIZE = 50;

/** Query flags for the export endpoints: the per-profile event summary is ~75% of a record. */
export function exportQuery(batchSize: number | undefined, includeEventSummary: boolean | undefined) {
  return {
    batch_size: Math.max(MIN_PAGE_SIZE, batchSize ?? DEFAULT_PAGE_SIZE),
    events: includeEventSummary ? undefined : "false",
  };
}

export interface PageOptions {
  deadline?: number;
  /** The caller explicitly asked for unredacted PII (ignored when the server forces redaction). */
  includePii?: boolean;
}

/** What a step-1 call returns when the caller only wants the cursor (fetch_first_page: false). */
export function cursorOnly(
  step1: { cursor?: string } & Record<string, unknown>,
  cursorTool: string,
  includePii = false
) {
  const handle = cursorStore.put(String(step1.cursor), includePii);
  const next: NextAction = {
    tool: cursorTool,
    args: { cursor: handle },
    why: "Fetch the first page.",
  };
  return { ...step1, cursor: handle, next_actions: [next] };
}

/** First page of an export: the cursor CleverTap just returned is turned into a handle right away,
 * so that even a failed first fetch offers the caller the short form to retry with. */
export async function startCursorPage(
  client: CleverTapClient,
  path: string,
  rawCursor: string,
  cursorTool: string,
  opts: PageOptions = {}
): Promise<Record<string, unknown>> {
  const handle = cursorStore.put(rawCursor, opts.includePii === true);
  return fetchCursorPage(client, path, handle, cursorTool, opts.deadline);
}

/**
 * Fetches one page of a cursor export and tells the caller how to get the next one.
 * CleverTap omits next_cursor on the last page, and returns no records key at all
 * when the range is empty, so both are normalised here. The cursor that goes out is a
 * short handle (see cursors.ts), and a handle or a raw cursor comes in.
 *
 * Records are redacted (see redact.ts) unless the export was started with include_pii; the
 * choice travels with the handle, so a later page cannot silently change it. The handle keeps
 * what the caller ASKED for; the server's CLEVERTAP_REDACT_PII=always is applied on every read.
 */
export async function fetchCursorPage(
  client: CleverTapClient,
  path: string,
  cursorOrHandle: string,
  cursorTool: string,
  deadline?: number
): Promise<Record<string, unknown>> {
  const { cursor, includePii } = cursorStore.resolveEntry(cursorOrHandle);
  const showPii = includePii && !piiForced();
  const raw = await client.getCursorPage(path, cursor, {
    deadline,
    retryTool: cursorTool,
    retryCursor: cursorOrHandle,
  });

  const stats: RedactionStats = { keys: 0, values: 0 };
  const source = Array.isArray(raw.records) ? raw.records : [];
  const records = showPii ? source : source.map((record) => redactPii(record, stats));
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor ? raw.next_cursor : undefined;

  const page: Record<string, unknown> = {
    ...raw,
    status: raw.status ?? "success",
    records,
    records_count: records.length,
    done: nextCursor === undefined,
  };
  if (!showPii) {
    page.pii_redacted = true;
    page.redactions = stats.keys + stats.values;
    page.pii_note = includePii && piiForced()
      ? "PII output is disabled on this server (CLEVERTAP_REDACT_PII=always): records are redacted."
      : PII_NOTE;
  }

  if (nextCursor === undefined) {
    delete page.next_cursor;
    page.note = "No more pages: CleverTap returned no next_cursor.";
    return page;
  }
  const handle = cursorStore.put(nextCursor, includePii);
  page.next_cursor = handle;
  const next: NextAction = {
    tool: cursorTool,
    args: { cursor: handle },
    why: "Fetch the next page with this cursor, exactly as written.",
  };
  page.next_actions = [next];
  return page;
}
