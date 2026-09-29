import { CleverTapToolError, NextAction, hintsFor } from "./errors.js";

export type CleverTapRegion = "in1" | "us1" | "eu1" | "sg1" | "aps3" | "mec1";

export interface CleverTapConfig {
  accountId: string;
  passcode: string;
  region: CleverTapRegion;
  /** Longest a single HTTP request may take. Default 40 s. */
  timeoutMs?: number;
  /**
   * Longest a whole tool call may take (polling, paging, chunking included).
   * Default 50 s, under the 62 s cut-off the Yummy platform applies to tool calls,
   * so a slow query comes back as a recoverable result instead of a hard timeout.
   */
  budgetMs?: number;
  /** Delay between polls of a pending query. Default 3 s. */
  pollDelayMs?: number;
  /** First back-off after an HTTP 429. Doubles on each retry. Default 1 s. */
  backoffBaseMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 40_000;
export const DEFAULT_BUDGET_MS = 50_000;
const DEFAULT_POLL_DELAY_MS = 3_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const MAX_429_RETRIES = 2;
/** Time kept in reserve so the last request of a budget still has room to answer. */
const RESERVE_MS = 1_000;

type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  /**
   * Retry (twice, with back-off) when CleverTap answers HTTP 429. Always on for GET.
   * POST/DELETE only when the caller opts in, because a POST can be a write and
   * repeating a write that may have been applied is not safe.
   */
  retryOn429?: boolean;
  query?: Record<string, QueryValue>;
  /** Appended verbatim. For values CleverTap already percent-encoded, such as cursors. */
  rawQuery?: string;
  timeoutMs?: number;
}

export interface PollOptions {
  deadline?: number;
  delayMs?: number;
  maxAttempts?: number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function isPartial(result: unknown): result is { status: "partial"; req_id: string | number } {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return (
    record.status === "partial" &&
    (typeof record.req_id === "string" || typeof record.req_id === "number")
  );
}

/** Adds the follow-up call that finishes a query CleverTap is still computing. */
export function withPollHint(
  path: string,
  result: { status: "partial"; req_id: string | number }
): Record<string, unknown> {
  const action: NextAction = {
    tool: "clevertap_poll",
    args: { path, req_id: String(result.req_id) },
    why: "CleverTap is still computing this query. Poll again in a few seconds.",
  };
  return { ...result, next_actions: [action] };
}

export class CleverTapClient {
  readonly region: CleverTapRegion;
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private budgetMs: number;
  private pollDelayMs: number;
  private backoffBaseMs: number;

  constructor(config: CleverTapConfig) {
    this.region = config.region;
    this.baseUrl = `https://${config.region}.api.clevertap.com/1`;
    this.headers = {
      "X-CleverTap-Account-Id": config.accountId,
      "X-CleverTap-Passcode": config.passcode,
      "Content-Type": "application/json",
    };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS;
    this.pollDelayMs = config.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  }

  /** Point in time (ms since epoch) at which the current tool call must have answered. */
  deadline(): number {
    return Date.now() + this.budgetMs;
  }

  remaining(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  async get<T>(path: string, params?: Record<string, string>, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, { ...opts, query: { ...params, ...opts.query } });
  }

  async post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  async delete<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, body, opts);
  }

  /**
   * POSTs a query and, if CleverTap answers "partial", polls it until it finishes or
   * the time budget runs out. When it does not finish in time the result carries a
   * next_actions entry that continues with clevertap_poll.
   */
  async postWithPolling(
    path: string,
    body: unknown,
    opts: PollOptions & RequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const deadline = opts.deadline ?? this.deadline();
    const first = await this.post<Record<string, unknown>>(path, body, {
      query: opts.query,
      timeoutMs: this.remaining(deadline),
      retryOn429: true, // polling endpoints are reads
    });
    if (!isPartial(first)) return first;
    return this.pollReqId(path, String(first.req_id), {
      deadline,
      delayMs: opts.delayMs,
      maxAttempts: opts.maxAttempts,
    });
  }

  /** Polls GET {path}?req_id=... until the query is no longer "partial" or the budget ends. */
  async pollReqId(path: string, reqId: string, opts: PollOptions = {}): Promise<Record<string, unknown>> {
    const deadline = opts.deadline ?? this.deadline();
    const delay = opts.delayMs ?? this.pollDelayMs;
    const maxAttempts = opts.maxAttempts ?? 15;
    let result: Record<string, unknown> = { status: "partial", req_id: reqId };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.remaining(deadline) <= delay + RESERVE_MS) break;
      await sleep(delay);
      result = await this.get<Record<string, unknown>>(
        path,
        { req_id: reqId },
        { timeoutMs: this.remaining(deadline) }
      );
      if (!isPartial(result)) return result;
    }
    return withPollHint(path, isPartial(result) ? result : { status: "partial", req_id: reqId });
  }

  /**
   * Fetches one page of a cursor-paginated export (events.json, profiles.json).
   * The cursor is sent exactly as CleverTap returned it: it is already percent-encoded,
   * and encoding it again makes CleverTap answer "Incorrect Usage". While CleverTap is
   * still preparing the page ("Request still in progress") the call is retried until
   * the time budget runs out.
   */
  async getCursorPage(
    path: string,
    cursor: string,
    opts: { deadline?: number; retryTool: string; retryCursor?: string }
  ): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9%_\-.~+=/]+$/.test(cursor)) {
      throw new CleverTapToolError("The cursor contains characters that never appear in CleverTap cursors.", {
        hints: [
          "Pass the cursor exactly as it was returned in cursor / next_cursor: do not edit, decode or re-encode it.",
        ],
      });
    }
    const deadline = opts.deadline ?? this.deadline();
    const delay = this.pollDelayMs;

    for (;;) {
      try {
        return await this.request<Record<string, unknown>>("GET", path, undefined, {
          rawQuery: `cursor=${cursor}`,
          timeoutMs: this.remaining(deadline),
        });
      } catch (error) {
        if (!(error instanceof CleverTapToolError) || !error.inProgress) throw error;
        if (this.remaining(deadline) > delay + RESERVE_MS) {
          await sleep(delay);
          continue;
        }
        throw new CleverTapToolError(error.message, {
          httpStatus: error.httpStatus,
          apiCode: error.apiCode,
          body: error.body,
          retryable: true,
          inProgress: true,
          hints: [
            ...error.hints,
            "CleverTap is still preparing this page. Retry with the same cursor: it keeps its position.",
          ],
          nextActions: [
            {
              tool: opts.retryTool,
              args: { cursor: opts.retryCursor ?? cursor },
              why: "Retry the same page in a few seconds.",
            },
          ],
        });
      }
    }
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    opts: RequestOptions = {}
  ): Promise<T> {
    if (!path.startsWith("/")) {
      throw new CleverTapToolError(`The API path must start with "/" (got "${path}").`);
    }
    const url = this.buildUrl(path, opts);
    const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? this.timeoutMs, this.timeoutMs));

    for (let attempt = 0; ; attempt++) {
      const response = await this.send(method, url, body, timeoutMs, path);
      const mayRetry = method === "GET" || opts.retryOn429 === true;
      if (response.status === 429 && mayRetry && attempt < MAX_429_RETRIES) {
        await sleep(this.backoffBaseMs * 2 ** attempt);
        continue;
      }
      return this.interpret<T>(method, path, response.status, response.text);
    }
  }

  private buildUrl(path: string, opts: RequestOptions): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    let out = url.toString();
    if (opts.rawQuery) {
      out += (out.includes("?") ? "&" : "?") + opts.rawQuery;
    }
    return out;
  }

  private async send(
    method: string,
    url: string,
    body: unknown,
    timeoutMs: number,
    path: string
  ): Promise<{ status: number; text: string }> {
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new CleverTapToolError(
          `CleverTap did not answer ${method} ${path} within ${Math.round(timeoutMs / 100) / 10}s.`,
          {
            retryable: true,
            hints: [
              "The query is too heavy for one request. Narrow the date range, add filters or lower batch_size, then retry. Cursor calls can be repeated with the same cursor.",
              "If the call modifies data, check its effect before repeating it.",
            ],
          }
        );
      }
      throw new CleverTapToolError(
        `Could not reach CleverTap (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }
  }

  private interpret<T>(method: string, path: string, status: number, text: string): T {
    let parsed: unknown;
    let isJson = false;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }
    }
    const obj =
      isJson && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;

    // CleverTap reports many failures as HTTP 200 with {"status":"fail"}.
    if (status < 200 || status >= 300 || obj?.status === "fail") {
      throw this.apiError(method, path, status, obj, text);
    }
    if (!isJson) {
      throw new CleverTapToolError(
        `CleverTap returned an empty or non-JSON body for ${method} ${path} (HTTP ${status}).`,
        {
          httpStatus: status,
          body: text.slice(0, 500),
          hints: ["Check that the path is a real CleverTap API endpoint for this region."],
        }
      );
    }
    return parsed as T;
  }

  private apiError(
    method: string,
    path: string,
    status: number,
    obj: Record<string, unknown> | undefined,
    text: string
  ): CleverTapToolError {
    const rawCode = obj?.code;
    const rawError = obj?.error;
    const apiCode = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : undefined;
    const apiMessage =
      typeof rawError === "string"
        ? rawError
        : rawError !== undefined
          ? JSON.stringify(rawError)
          : undefined;
    const detail = apiMessage ?? (text.trim() ? text.trim().slice(0, 500) : `HTTP ${status}`);
    const inProgress = String(apiCode) === "2" || /still in progress/i.test(detail);

    return new CleverTapToolError(`CleverTap API error ${apiCode ?? status}: ${detail}`, {
      httpStatus: status,
      apiCode,
      body: obj ?? text.slice(0, 500),
      hints: hintsFor({ method, path, region: this.region }, status, apiCode, detail),
      retryable: inProgress || status === 429 || status >= 500,
      inProgress,
    });
  }
}
