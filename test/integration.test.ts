import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import plugin from "../src/index.js";
import { fakeApi } from "./fakeApi.js";
import type {
  AgentTool,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  HttpRouteHandler,
  MessageSendingEvent,
  MessageSendingResult,
  SessionEndEvent,
} from "../src/openclaw.js";

/**
 * Task 9 — full end-to-end integration.
 *
 * This is the only test that drives the plugin exactly as the real OpenClaw
 * gateway would: through the captured registrations from `fakeApi` (tool, HTTP
 * route, hooks), with NO direct calls into the individual units. It proves the
 * complete out-of-band, use-once credential flow and guards the wiring against
 * regressions.
 *
 * The literal secret value is referenced through this constant so the "no leak
 * anywhere" assertion can scan every captured log/console line for it.
 */
const SECRET = "SUPER-SECRET-VALUE-123";
const PUBLIC_URL = "https://gw.example.ts.net";

/** Concatenate every text segment of a ToolResult. */
function textOf(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Grab the (single) registered handler for a hook, or fail loudly. */
function hook<T extends Function>(
  hooks: Record<string, Function[]>,
  name: string,
): T {
  const list = hooks[name];
  if (!list || list.length === 0) {
    throw new Error(`expected a registered "${name}" hook`);
  }
  return list[0] as unknown as T;
}

/** Start an http.Server whose request listener IS the plugin route handler. */
async function startServer(
  handler: HttpRouteHandler,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    // The gateway invokes the handler directly; mirror that. Any throw becomes
    // a 500 so the client still gets a response (and the test isn't left hung).
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("integration — full end-to-end via fakeApi", () => {
  // Servers opened during a test are tracked here and torn down afterEach so a
  // failed assertion can never leak a listening socket.
  const openServers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (openServers.length > 0) {
      const s = openServers.pop()!;
      await s.close().catch(() => {});
    }
    vi.restoreAllMocks();
  });

  it("mints → submits out-of-band → redacts live → resolves once → wiped (single-use) → no leak", async () => {
    // Spy on EVERY console channel + the api logger for the whole flow so we can
    // prove the literal value is never written anywhere.
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

    // (1) Register the plugin through its real surface.
    const { api, tools, hooks, routes, logs } = fakeApi({
      pluginConfig: { publicUrl: PUBLIC_URL },
    });
    await plugin.register(api);

    // Sanity: the gateway would see exactly the registrations we expect.
    expect(tools).toHaveLength(1);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/secret");

    // (2) Mint: drive the agent-facing tool.
    const tool = tools[0] as AgentTool;
    expect(tool.name).toBe("request_secret");
    const res = await tool.execute("call-1", { label: "openai-api-key" });
    const text = textOf(res);

    // The result advertises the public intake link and the placeholder usage…
    expect(text).toContain(`${PUBLIC_URL}/secret?token=`);
    const details = res.details as { key: string; link: string };
    const key = details.key;
    expect(text).toContain(`{{secret:${key}}}`);
    // …and carries NO secret value (there is none yet).
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(res.details)).not.toContain(SECRET);

    // Parse the capability token straight out of the minted link.
    const link = `${PUBLIC_URL}/secret?token=`;
    expect(details.link.startsWith(link)).toBe(true);
    const token = new URL(details.link).searchParams.get("token");
    expect(token).toBeTruthy();

    // (3) Submit out-of-band: stand up the REAL intake route on a socket and POST
    //     the value to it, exactly as a human's browser would.
    const handler = routes[0].handler;
    const srv = await startServer(handler);
    openServers.push(srv);

    const post = await fetch(
      `http://127.0.0.1:${srv.port}/secret?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(SECRET)}`,
      },
    );
    expect(post.status).toBe(200);
    // Drain the response body (a value-free "Received" page) so the socket closes.
    const postBody = await post.text();
    expect(postBody).not.toContain(SECRET);

    // (4) Redaction while live (BEFORE use): the value is now in the store, so the
    //     outbound backstop catches an accidental echo.
    const messageSending = hook<
      (e: MessageSendingEvent) => MessageSendingResult
    >(hooks, "message_sending");
    const redactedLive = messageSending({
      to: "x",
      content: `leaked: ${SECRET} oops`,
    });
    expect(redactedLive).toEqual({ content: "leaked: [redacted-secret] oops" });

    // (5) Resolve at point-of-use: the resolver swaps the placeholder for the real
    //     value at the tool boundary; non-placeholder fields are untouched.
    const beforeToolCall = hook<
      (e: BeforeToolCallEvent) => BeforeToolCallResult
    >(hooks, "before_tool_call");
    const resolved = beforeToolCall({
      toolName: "http_request",
      params: {
        headers: { Authorization: `Bearer {{secret:${key}}}` },
        url: "https://api.openai.com",
      },
    });
    expect(resolved).toEqual({
      params: {
        headers: { Authorization: `Bearer ${SECRET}` },
        url: "https://api.openai.com",
      },
    });

    // (6) Single-use (use-once): the SAME placeholder now blocks — the value was wiped
    //     the instant it was resolved in step 5.
    const blocked = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${key}}}` } },
    });
    expect(blocked).toBeTruthy();
    expect(blocked && blocked.block).toBe(true);
    expect(blocked && blocked.blockReason).toContain(key);
    // A blocked call never returns rewritten params.
    expect(blocked && (blocked as { params?: unknown }).params).toBeUndefined();

    // (7) Redaction after wipe: nothing is live, so the same echo now passes
    //     through unchanged (undefined = no rewrite).
    const redactedAfter = messageSending({
      to: "x",
      content: `leaked: ${SECRET} oops`,
    });
    expect(redactedAfter).toBeUndefined();

    // (8) No leak anywhere: across the entire flow the literal value must never
    //     have hit any console channel or the api logger.
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET);
      }
    }
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    // The only thing the plugin logs at all is the static registration fact.
    expect(logs).toEqual([{ level: "info", args: ["secret-tunnel registered"] }]);
  });

  it("session-lifetime secret resolves more than once, then session_end wipes it", async () => {
    // Same spies so this scenario also proves no value leaks.
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

    const { api, tools, hooks, routes, logs } = fakeApi({
      pluginConfig: { publicUrl: PUBLIC_URL },
    });
    await plugin.register(api);

    // Mint a SESSION-lifetime secret.
    const tool = tools[0] as AgentTool;
    const res = await tool.execute("call-s", {
      label: "postgres-password",
      lifetime: "session",
    });
    const details = res.details as { key: string; link: string; lifetime: string };
    expect(details.lifetime).toBe("session");
    const key = details.key;
    const token = new URL(details.link).searchParams.get("token");

    // Submit the value out-of-band through the real route.
    const srv = await startServer(routes[0].handler);
    openServers.push(srv);
    const post = await fetch(
      `http://127.0.0.1:${srv.port}/secret?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(SECRET)}`,
      },
    );
    expect(post.status).toBe(200);
    await post.text();

    const beforeToolCall = hook<
      (e: BeforeToolCallEvent) => BeforeToolCallResult
    >(hooks, "before_tool_call");

    // Resolve TWICE — a session secret survives repeated use.
    const first = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${key}}}` } },
    });
    expect(first).toEqual({
      params: { headers: { Authorization: `Bearer ${SECRET}` } },
    });
    const second = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${key}}}` } },
    });
    expect(second).toEqual({
      params: { headers: { Authorization: `Bearer ${SECRET}` } },
    });

    // session_end wipes it; a subsequent resolve blocks.
    const sessionEnd = hook<(e: SessionEndEvent) => unknown>(hooks, "session_end");
    expect(() => sessionEnd({ sessionId: "s1" })).not.toThrow();

    const afterEndCall = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${key}}}` } },
    });
    expect(afterEndCall).toBeTruthy();
    expect(afterEndCall && afterEndCall.block).toBe(true);
    expect(afterEndCall && afterEndCall.blockReason).toContain(key);

    // No value ever leaked.
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET);
      }
    }
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});
