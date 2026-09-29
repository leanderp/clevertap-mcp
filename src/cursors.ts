import { randomBytes } from "node:crypto";
import { CleverTapToolError } from "./errors.js";

const HANDLE_PREFIX = "cur_";
/** Event cursors expire 4 hours after creation, so a handle never needs to outlive that. */
const TTL_MS = 4 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  cursor: string;
  expiresAt: number;
  /** Whether the caller asked for unredacted PII when the export started; later pages inherit it. */
  includePii: boolean;
}

/**
 * CleverTap cursors are opaque tokens of ~1.5-2.4 KB. A model that has to repeat one
 * verbatim in the next tool call corrupts it (a duplicated fragment is enough for
 * "Incorrect Usage"), so tools hand out a short handle instead and resolve it here.
 *
 * The map lives in the memory of this process only. It is lost when the process is
 * restarted (the bridge stops idle children after a few minutes) or when another
 * instance answers; resolve() then fails with instructions to restart the export.
 * Raw cursors are still accepted, so nothing that worked before stops working.
 */
export class CursorStore {
  private entries = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  put(cursor: string, includePii = false): string {
    this.prune();
    for (const [handle, entry] of this.entries) {
      if (entry.cursor === cursor) {
        entry.expiresAt = this.now() + TTL_MS;
        entry.includePii = includePii;
        return handle;
      }
    }
    const handle = HANDLE_PREFIX + randomBytes(6).toString("hex");
    this.entries.set(handle, { cursor, expiresAt: this.now() + TTL_MS, includePii });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return handle;
  }

  /** Turns a handle into the raw cursor; anything that is not a handle passes through. */
  resolve(value: string): string {
    return this.resolveEntry(value).cursor;
  }

  /** Like resolve(), plus the PII choice the export was started with (raw cursors: redacted). */
  resolveEntry(value: string): { cursor: string; includePii: boolean } {
    if (!value.startsWith(HANDLE_PREFIX)) return { cursor: value, includePii: false };
    const entry = this.entries.get(value);
    if (!entry || entry.expiresAt < this.now()) {
      throw new CleverTapToolError(`The cursor handle "${value}" is unknown or expired.`, {
        hints: [
          "Handles are kept in the memory of the MCP process for up to 4 hours and are lost when it restarts (it stops after a few idle minutes) or when another instance answers.",
          "Restart the export with clevertap_get_events / clevertap_get_profiles_by_event (same arguments) and continue from the new next_cursor.",
        ],
      });
    }
    return { cursor: entry.cursor, includePii: entry.includePii };
  }

  private prune(): void {
    const now = this.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(handle);
    }
  }
}

export const cursorStore = new CursorStore();
