import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CleverTapToolError } from "../dist/errors.js";
import { json, makeClient, mockFetch } from "./helpers.mjs";

let mock;
afterEach(() => mock?.restore());

test("sends a cursor exactly as CleverTap returned it (no double encoding)", async () => {
  const cursor = "AbC%2FdE%3D%3D";
  mock = mockFetch(() => json({ status: "success", records: [] }));
  await makeClient().getCursorPage("/events.json", cursor, { retryTool: "t" });
  assert.equal(mock.calls[0].url, `https://us1.api.clevertap.com/1/events.json?cursor=${cursor}`);
});

test("rejects cursors with characters CleverTap never emits", async () => {
  mock = mockFetch(() => json({ status: "success" }));
  await assert.rejects(
    makeClient().getCursorPage("/events.json", "a&b=c d", { retryTool: "t" }),
    /cursor/
  );
  assert.equal(mock.calls.length, 0);
});

test("retries a cursor page while CleverTap says the request is still in progress", async () => {
  mock = mockFetch((_call, index) =>
    index === 0
      ? json({ status: "fail", error: "Request still in progress, please retry later", code: 2 })
      : json({ status: "success", records: [{ a: 1 }] })
  );
  const page = await makeClient({ budgetMs: 5000 }).getCursorPage("/profiles.json", "CUR", {
    retryTool: "clevertap_get_profiles_cursor",
  });
  assert.equal(mock.calls.length, 2);
  assert.equal(page.records.length, 1);
});

test("when a cursor page never becomes ready the error says how to retry it", async () => {
  mock = mockFetch(() => json({ status: "fail", error: "Request still in progress, please retry later", code: 2 }));
  await assert.rejects(
    makeClient({ budgetMs: 1500 }).getCursorPage("/profiles.json", "CUR%2F1", {
      retryTool: "clevertap_get_profiles_cursor",
    }),
    (error) => {
      assert.ok(error instanceof CleverTapToolError);
      assert.equal(error.nextActions[0].tool, "clevertap_get_profiles_cursor");
      assert.deepEqual(error.nextActions[0].args, { cursor: "CUR%2F1" });
      return true;
    }
  );
});

test("an HTTP 200 with status fail is an error, with recovery hints", async () => {
  mock = mockFetch(() => json({ status: "fail", error: '["Invalid event : Uninstalled"]', code: 400 }));
  await assert.rejects(makeClient().post("/counts/trends.json", {}), (error) => {
    assert.ok(error instanceof CleverTapToolError);
    assert.match(error.message, /Invalid event/);
    assert.ok(error.hints.some((hint) => /case-sensitive/.test(hint)));
    return true;
  });
});

test("an empty body is reported instead of crashing the JSON parser", async () => {
  mock = mockFetch(() => new Response("", { status: 200 }));
  await assert.rejects(makeClient().get("/nope.json"), /empty or non-JSON/);
});

test("a hanging request is cut off by the client timeout", async () => {
  mock = mockFetch(
    (_call, _index, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout() does not keep the event loop alive (a real socket would),
        // so hold it open until the abort fires.
        const keepAlive = setInterval(() => {}, 1000);
        init.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(init.signal.reason);
        });
      })
  );
  await assert.rejects(makeClient({ timeoutMs: 30 }).get("/now.json"), (error) => {
    assert.ok(error instanceof CleverTapToolError);
    assert.match(error.message, /did not answer/);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("retries an HTTP 429 with back-off and then succeeds", async () => {
  mock = mockFetch((_call, index) =>
    index === 0
      ? json({ status: "fail", error: "Too many concurrent requests", code: 429 }, 429)
      : json({ status: "success", count: 1 })
  );
  const result = await makeClient().post("/now.json", {}, { retryOn429: true });
  assert.equal(result.count, 1);
  assert.equal(mock.calls.length, 2);
});

test("never retries a POST on 429 unless the caller opts in (it may be a write)", async () => {
  mock = mockFetch(() => json({ status: "fail", error: "Too many concurrent requests", code: 429 }, 429));
  await assert.rejects(makeClient().post("/upload", { d: [] }), /429/);
  assert.equal(mock.calls.length, 1);
});

test("retries a GET on 429 without opting in", async () => {
  mock = mockFetch((_call, index) =>
    index === 0
      ? json({ status: "fail", error: "Too many concurrent requests", code: 429 }, 429)
      : json({ status: "success", count: 2 })
  );
  const result = await makeClient().get("/now.json");
  assert.equal(result.count, 2);
});

test("gives up on a persistent HTTP 429 after two retries", async () => {
  mock = mockFetch(() => json({ status: "fail", error: "Too many concurrent requests", code: 429 }, 429));
  await assert.rejects(makeClient().post("/now.json", {}, { retryOn429: true }), /429/);
  assert.equal(mock.calls.length, 3);
});

test("requires API paths to start with a slash", async () => {
  mock = mockFetch(() => json({ status: "success" }));
  await assert.rejects(makeClient().get("now.json"), /must start with/);
  assert.equal(mock.calls.length, 0);
});

test("postWithPolling follows req_id until the query finishes", async () => {
  mock = mockFetch((call, index) => {
    if (call.method === "POST") return json({ status: "partial", req_id: 123 });
    return index < 2 ? json({ status: "partial", req_id: 123 }) : json({ status: "success", count: 7 });
  });
  const result = await makeClient({ budgetMs: 5000 }).postWithPolling("/counts/events.json", {});
  assert.equal(result.count, 7);
  assert.equal(mock.calls[1].url, "https://us1.api.clevertap.com/1/counts/events.json?req_id=123");
  assert.equal(mock.calls.length, 3);
});

test("postWithPolling that runs out of time hands back a clevertap_poll next action", async () => {
  mock = mockFetch(() => json({ status: "partial", req_id: 123 }));
  const result = await makeClient({ budgetMs: 1500 }).postWithPolling("/counts/events.json", {});
  assert.equal(result.status, "partial");
  assert.deepEqual(result.next_actions[0].args, { path: "/counts/events.json", req_id: "123" });
  assert.equal(result.next_actions[0].tool, "clevertap_poll");
});

/** What fetch throws when it gets no HTTP answer: "fetch failed" with the reason in cause. */
function fetchFailed(cause) {
  return new TypeError("fetch failed", cause === undefined ? undefined : { cause });
}

function errno(code) {
  return Object.assign(new Error(code), { code });
}

test("retries a write when the connection never opened (nothing reached CleverTap)", async () => {
  mock = mockFetch((_call, index) => {
    if (index === 0) throw fetchFailed(errno("EAI_AGAIN"));
    return json({ status: "success", processed: 1 });
  });
  const result = await makeClient().post("/upload", { d: [] });
  assert.equal(result.processed, 1);
  assert.equal(mock.calls.length, 2);
});

test("reads the errno inside an AggregateError (several addresses tried)", async () => {
  mock = mockFetch((_call, index) => {
    if (index === 0) {
      throw fetchFailed(new AggregateError([errno("ECONNREFUSED"), errno("ENETUNREACH")], "connect failed"));
    }
    return json({ status: "success", count: 7 });
  });
  const result = await makeClient().post("/upload", { d: [] });
  assert.equal(result.count, 7);
  assert.equal(mock.calls.length, 2);
});

test("does not repeat a write after a reset (CleverTap may have received it)", async () => {
  mock = mockFetch(() => {
    throw fetchFailed(errno("ECONNRESET"));
  });
  const error = await makeClient().post("/upload", { d: [] }).catch((e) => e);
  assert.ok(error instanceof CleverTapToolError);
  assert.match(error.message, /Could not reach CleverTap \(POST \/upload\): fetch failed \(ECONNRESET\)/);
  assert.ok(error.hints.some((h) => /check its effect/.test(h)));
  assert.equal(mock.calls.length, 1);
});

test("repeats a read after a reset", async () => {
  mock = mockFetch((_call, index) => {
    if (index === 0) throw fetchFailed(errno("ECONNRESET"));
    return json({ status: "success", count: 3 });
  });
  const result = await makeClient().post("/counts/profiles.json", {}, { retryOn429: true });
  assert.equal(result.count, 3);
  assert.equal(mock.calls.length, 2);
});

test("gives up after two network retries and names the cause", async () => {
  mock = mockFetch(() => {
    throw fetchFailed(errno("EAI_AGAIN"));
  });
  const error = await makeClient().get("/now.json").catch((e) => e);
  assert.ok(error instanceof CleverTapToolError);
  assert.equal(error.retryable, true);
  assert.match(error.message, /\(GET \/now\.json\): fetch failed \(EAI_AGAIN\)/);
  assert.ok(error.hints.some((h) => /3 times/.test(h)));
  assert.equal(mock.calls.length, 3);
});

test("a write without a known cause is not repeated and the message stays readable", async () => {
  mock = mockFetch(() => {
    throw fetchFailed();
  });
  const error = await makeClient().post("/upload", { d: [] }).catch((e) => e);
  assert.match(error.message, /\(POST \/upload\): fetch failed$/);
  assert.equal(mock.calls.length, 1);
});

test("a write that failed after a retry still warns to check its effect", async () => {
  mock = mockFetch((_call, index) => {
    throw fetchFailed(errno(index === 0 ? "EAI_AGAIN" : "ECONNRESET"));
  });
  const error = await makeClient().post("/upload", { d: [] }).catch((e) => e);
  assert.equal(mock.calls.length, 2);
  assert.ok(error.hints.some((h) => /2 times/.test(h)));
  assert.ok(error.hints.some((h) => /check its effect/.test(h)));
});

test("network retries stop when the request's time is used up", async () => {
  mock = mockFetch(() => {
    throw fetchFailed(errno("EAI_AGAIN"));
  });
  // 500 ms of time, 1 s of back-off: there is no room for a retry.
  const client = makeClient({ backoffBaseMs: 1_000 });
  const error = await client.get("/now.json", undefined, { timeoutMs: 500 }).catch((e) => e);
  assert.match(error.message, /EAI_AGAIN/);
  assert.equal(mock.calls.length, 1);
});
