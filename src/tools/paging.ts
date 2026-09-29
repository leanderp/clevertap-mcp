import { CleverTapClient } from "../client.js";
import { NextAction } from "../errors.js";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 1000;

/**
 * Fetches one page of a cursor export and tells the caller how to get the next one.
 * CleverTap omits next_cursor on the last page, and returns no records key at all
 * when the range is empty, so both are normalised here.
 */
export async function fetchCursorPage(
  client: CleverTapClient,
  path: string,
  cursor: string,
  cursorTool: string,
  deadline?: number
): Promise<Record<string, unknown>> {
  const raw = await client.getCursorPage(path, cursor, { deadline, retryTool: cursorTool });
  const records = Array.isArray(raw.records) ? raw.records : [];
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor ? raw.next_cursor : undefined;

  const page: Record<string, unknown> = {
    ...raw,
    status: raw.status ?? "success",
    records,
    records_count: records.length,
    done: nextCursor === undefined,
  };

  if (nextCursor === undefined) {
    page.note = "No more pages: CleverTap returned no next_cursor.";
    return page;
  }
  const next: NextAction = {
    tool: cursorTool,
    args: { cursor: nextCursor },
    why: "Fetch the next page. Pass the cursor exactly as returned.",
  };
  page.next_actions = [next];
  return page;
}
