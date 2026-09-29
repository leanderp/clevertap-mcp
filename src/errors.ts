/**
 * A follow-up call a caller (usually an LLM) can make to recover from a failure
 * or to fetch more data. Returned inside results and errors so the tools tell
 * the caller what to do next instead of leaving it to guess.
 */
export interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface ErrorContext {
  method: string;
  path: string;
  region: string;
}

export interface ToolErrorInit {
  httpStatus?: number;
  apiCode?: number | string;
  body?: unknown;
  hints?: string[];
  nextActions?: NextAction[];
  retryable?: boolean;
  inProgress?: boolean;
}

/** Every failure a tool can report: API errors, timeouts and invalid input. */
export class CleverTapToolError extends Error {
  readonly httpStatus?: number;
  readonly apiCode?: number | string;
  readonly body?: unknown;
  readonly hints: string[];
  readonly nextActions: NextAction[];
  readonly retryable: boolean;
  /** CleverTap answered "Request still in progress" (code 2): retry the same call. */
  readonly inProgress: boolean;

  constructor(message: string, init: ToolErrorInit = {}) {
    super(message);
    this.name = "CleverTapToolError";
    this.httpStatus = init.httpStatus;
    this.apiCode = init.apiCode;
    this.body = init.body;
    this.hints = init.hints ?? [];
    this.nextActions = init.nextActions ?? [];
    this.retryable = init.retryable ?? false;
    this.inProgress = init.inProgress ?? false;
  }
}

const SYSTEM_EVENTS =
  "App Launched, App Installed, App Uninstalled, Charged, Notification Sent, Notification Viewed, Product Viewed, UTM Visited";

const REGIONS = "in1, us1, eu1, sg1, aps3, mec1";

/**
 * Recovery hints for the failures seen against the real API. Kept short and
 * specific: each one says what was wrong and what to change.
 */
export function hintsFor(
  ctx: ErrorContext,
  httpStatus: number | undefined,
  apiCode: number | string | undefined,
  message: string
): string[] {
  const hints: string[] = [];
  const text = message.toLowerCase();
  const code = apiCode === undefined ? undefined : String(apiCode);

  if (httpStatus === 401 || code === "401" || text.includes("invalid credentials")) {
    hints.push(
      `Credentials were rejected for region "${ctx.region}". Check account_id and passcode, and that the region matches the account (one of: ${REGIONS}).`
    );
  }
  if (httpStatus === 429 || code === "429") {
    hints.push(
      "Too many concurrent requests. Wait a few seconds and retry, and avoid running several CleverTap calls in parallel."
    );
  }
  if (text.includes("invalid event")) {
    hints.push(
      `Event names are exact and case-sensitive. Standard events: ${SYSTEM_EVENTS}. Custom events must match the name used in the dashboard.`
    );
  }
  if (text.includes("invalid group")) {
    hints.push(
      "Each group needs a valid property_type (event_properties, session_properties, profile_fields, app_fields, demographics, technographics, reachability, geo_fields) and a name that exists for that type/event in this account."
    );
  }
  if (
    text.includes("invalid date") ||
    text.includes("date range") ||
    text.includes("from greater") ||
    code === "4002"
  ) {
    hints.push("Dates must be real calendar dates in YYYYMMDD format, from <= to, and not in the future.");
  }
  if (text.includes("invalid request id")) {
    hints.push(
      "The req_id is invalid or expired. Repeat the original query to get a new req_id, then poll it."
    );
  }
  if (
    text.includes("invalid cursor") ||
    text.includes("incorrect usage") ||
    code === "CURSOR_INVALIDATED"
  ) {
    hints.push(
      "Cursors are opaque: pass next_cursor exactly as returned (already percent-encoded, never URL-encode it again). Event cursors expire 4 hours after creation or after 1 hour of inactivity; profile cursors after 4 days. If it expired, restart from the first call."
    );
  }
  if (text.includes("batch_size")) {
    hints.push("batch_size must be an integer between 1 and 5000 (the events/profiles tools here accept up to 1000).");
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    hints.push("CleverTap reported a server-side error. Retry in a few seconds; if it persists, narrow the query (shorter date range, filters).");
  }
  return hints;
}

/**
 * Keeps only what explains a failure. CleverTap echoes the rejected records of an upload
 * (identity, email, phone, event and profile data) inside `unprocessed`; those never go
 * into an error message, which the host platform may log.
 */
export function redactBody(body: unknown): unknown {
  if (typeof body === "string") return body.slice(0, 300);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "(non-object response omitted)";
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["status", "code", "error", "req_id", "processed"]) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  if (Array.isArray(source.unprocessed)) {
    out.unprocessed_count = source.unprocessed.length;
    out.unprocessed_errors = source.unprocessed.slice(0, 20).map((item) => {
      const record = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      return { status: record.status, code: record.code, error: record.error };
    });
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}

/** Text shown to the caller when a tool fails. Always starts with "Error:". */
export function formatError(error: unknown): string {
  if (error instanceof CleverTapToolError) {
    const lines = [`Error: ${error.message}`];
    if (error.hints.length > 0) {
      lines.push("", "How to recover:", ...error.hints.map((h) => `- ${h}`));
    }
    if (error.nextActions.length > 0) {
      lines.push(
        "",
        "Suggested next calls:",
        ...error.nextActions.map((a) => `- ${a.tool} ${JSON.stringify(a.args)} — ${a.why}`)
      );
    }
    if (error.body !== undefined) {
      lines.push("", `API response: ${truncate(JSON.stringify(redactBody(error.body)), 2000)}`);
    }
    return lines.join("\n");
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
