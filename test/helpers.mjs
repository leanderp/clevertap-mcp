import { CleverTapClient } from "../dist/client.js";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Client with short delays so retry/poll paths run in milliseconds. */
export function makeClient(extra = {}) {
  return new CleverTapClient({
    accountId: "ACC",
    passcode: "PASS",
    region: "us1",
    pollDelayMs: 5,
    backoffBaseMs: 1,
    ...extra,
  });
}

/**
 * Replaces global fetch with `handler(url, init, callIndex)` and records every call.
 * Returns { calls, restore }.
 */
export function mockFetch(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1, init);
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

/** Runs a tool the way the MCP server does: parse the args with its schema, then call the handler. */
export async function callTool(tools, name, args, client) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No such tool: ${name}`);
  return tool.handler(client, tool.inputSchema.parse(args));
}
