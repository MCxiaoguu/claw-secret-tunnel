#!/usr/bin/env node
// @ts-check
/**
 * One-Time Secret Tunnel — runnable end-to-end demo ("see it working").
 *
 * This script drives the REAL compiled plugin (`../dist/index.js`) exactly the
 * way the OpenClaw gateway would, over REAL HTTP, and PRINTS each stage so a
 * human can watch the out-of-band, use-once credential flow happen:
 *
 *   1. Agent calls `request_secret`            → model sees a link + a key, NO value.
 *   2. Human opens the minted link (real GET)  → a one-field HTML form comes back.
 *   3. Human submits the secret (real POST)    → HTTP 200, value captured server-side.
 *   4. Agent uses {{secret:<key>}} in a call   → the value is injected at the boundary.
 *   5. Same placeholder again                  → BLOCKED (single-use value already wiped).
 *   6. Backstop: an accidental echo            → redacted by `message_sending`.
 *   7. No leak                                 → the value never appears in any log line.
 *
 * Nothing here reaches into the individual units. It registers the plugin through
 * its public `register(api)` surface, mounts the captured HTTP route on a real
 * `http.Server` (mirroring the gateway's exact-pathname dispatch in
 * `src/gateway/server/plugins-http.ts`: `routes.find(e => e.path === url.pathname)`),
 * and exercises the captured tool + hooks. Exit 0 iff every assertion holds.
 */

import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiny presentation + assertion helpers (no deps; deterministic output).
// ---------------------------------------------------------------------------

const SECRET = "sk-DEMO-1234567890"; // the value the agent must NEVER see
// We bind to an EPHEMERAL port (listen(0)) and read back the OS-assigned one, so
// the demo is collision-proof and deterministic even if a real OpenClaw gateway
// is already holding the default port 18789 on this host.

let stepNo = 0;
function section(title) {
  const bar = "=".repeat(78);
  console.log(`\n${bar}\n  STEP ${++stepNo}: ${title}\n${bar}`);
}
function note(msg) {
  console.log(msg);
}
/** Indent a multi-line block so quoted payloads stand apart from prose. */
function block(label, text) {
  console.log(`\n  ${label}:`);
  for (const line of String(text).split("\n")) console.log(`    | ${line}`);
}

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`\n  ✗ ASSERTION FAILED: ${msg}`);
    throw new Error(`assertion failed: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

/** Concatenate every text segment of a ToolResult. */
function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// A faithful, minimal OpenClawPluginApi (matches src/openclaw.ts). It captures
// every registration the plugin makes so the demo can drive them like the
// gateway does. The logger records every line so step 7 can prove no leak.
// ---------------------------------------------------------------------------

function makeApi(pluginConfig) {
  /** @type {Array<{level: string, message: string}>} */
  const logs = [];
  /** @type {any[]} */
  const tools = [];
  /** @type {Record<string, Function[]>} */
  const hooks = {};
  /** @type {Array<{path: string, handler: Function}>} */
  const routes = [];

  const record = (level) => (message) => logs.push({ level, message: String(message) });

  const api = {
    id: "secret-tunnel",
    name: "One-Time Secret Tunnel",
    source: "demo",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
    registerTool: (tool) => {
      tools.push(tool);
    },
    on: (hook, handler) => {
      (hooks[hook] ??= []).push(handler);
    },
    registerHttpRoute: (r) => {
      routes.push(r);
    },
    resolvePath: (p) => p,
  };

  return { api, logs, tools, hooks, routes };
}

/** Grab the (single) registered handler for a hook, or fail loudly. */
function hook(hooks, name) {
  const list = hooks[name];
  if (!list || list.length === 0) throw new Error(`expected a registered "${name}" hook`);
  return list[0];
}

/**
 * Stand up a real http.Server that dispatches to the captured plugin routes by
 * EXACT pathname — exactly like the gateway's plugin HTTP router
 * (`src/gateway/server/plugins-http.ts`: `routes.find(e => e.path === url.pathname)`).
 * Anything unmatched is a 404; a handler throw becomes a 500 so the client always
 * gets a response.
 *
 * `routes` is read LIVE on each request, so the server can be started before the
 * plugin registers its route (which it must be — the minted `publicUrl` has to
 * carry the OS-assigned ephemeral port). Binds to 127.0.0.1:0.
 */
function startGatewayLikeServer(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = routes.find((entry) => entry.path === url.pathname);
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolveListen({
        server,
        port: addr.port,
        close: () =>
          new Promise((r, rej) => server.close((err) => (err ? rej(err) : r(undefined)))),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The demo.
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n${"#".repeat(78)}`);
  console.log("#  One-Time Secret Tunnel — end-to-end demo (real plugin, real HTTP)");
  console.log(`#  The secret the agent must NEVER see: ${SECRET}`);
  console.log(`${"#".repeat(78)}`);

  // Import the REAL compiled plugin (built by `npm run build` before this runs).
  const distEntry = resolve(__dirname, "..", "dist", "index.js");
  /** @type {{ default: any }} */
  const mod = await import(pathToUrl(distEntry));
  const plugin = mod.default;
  assert(plugin && typeof plugin.register === "function", "loaded ./dist/index.js (real plugin)");
  assert(plugin.id === "secret-tunnel", `plugin id is "${plugin.id}"`);

  // Start the gateway-like server FIRST on an ephemeral port. It reads `routes`
  // live, so the plugin's soon-to-be-registered route will be served once added.
  const liveRoutes = [];
  const gw = await startGatewayLikeServer(liveRoutes);
  const publicUrl = `http://127.0.0.1:${gw.port}`;

  // Build the api with publicUrl bound to the REAL assigned port, then register
  // through the plugin's real surface — exactly what the gateway calls.
  const { api, logs, tools, hooks, routes } = makeApi({ publicUrl });
  await plugin.register(api);
  // Hand the captured route(s) to the already-listening server.
  liveRoutes.push(...routes);

  let exitCode = 0;
  try {
    assert(tools.length === 1, "plugin registered exactly one tool");
    assert(routes.length === 1, `plugin registered an HTTP route at "${routes[0].path}"`);
    note(`\n(Plugin wired: tool="${tools[0].name}", route="${routes[0].path}", ` +
      `hooks=[${Object.keys(hooks).join(", ")}], server=http://127.0.0.1:${gw.port})`);

    // === STEP 1 — Agent calls request_secret =============================
    section("Agent calls request_secret  (the model asks the human for a key)");
    const tool = tools[0];
    const minted = await tool.execute("call-1", { label: "OpenAI API key" });
    const mintedText = textOf(minted);
    const details = /** @type {{ key: string, link: string, lifetime: string }} */ (minted.details);
    const key = details.key;
    const link = details.link;

    block("Tool result the MODEL sees", mintedText);
    note("\n  ^ This is everything the model receives. Note what it contains and omits:");
    assert(mintedText.includes(link), "result contains the one-time link to relay");
    assert(mintedText.includes(`{{secret:${key}}}`), `result contains the placeholder {{secret:${key}}}`);
    assert(!mintedText.includes(SECRET), "result contains NO secret value (there is none yet)");
    assert(!JSON.stringify(minted.details).includes(SECRET), "structured details contain NO secret value");
    assert(link.startsWith(`${publicUrl}/secret?token=`), "link points at THIS demo server's intake route");

    const token = new URL(link).searchParams.get("token");
    assert(typeof token === "string" && token.length > 0, "minted link carries a capability token");

    // === STEP 2 — Human opens the link (real GET) =======================
    section("Human opens the link  (real GET → one-time HTML form)");
    note(`  GET ${link}`);
    const getRes = await fetch(link, { method: "GET" });
    const formHtml = await getRes.text();
    block(`HTML form returned (HTTP ${getRes.status})`, formHtml);
    assert(getRes.status === 200, "GET returned HTTP 200 (a pending one-time link)");
    assert(formHtml.includes("OpenAI API key"), "form shows the human-readable label");
    assert(formHtml.includes('name="secret"'), "form has a single secret input field");
    assert(!formHtml.includes(SECRET), "form contains NO value (nothing submitted yet)");

    // === STEP 3 — Human submits the secret (real POST) ==================
    section("Human submits the secret  (real POST → captured server-side, never logged)");
    note(`  POST ${link}   body: secret=${SECRET}`);
    const postRes = await fetch(link, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(SECRET)}`,
    });
    const postHtml = await postRes.text();
    block(`Confirmation page (HTTP ${postRes.status})`, postHtml);
    assert(postRes.status === 200, "POST returned HTTP 200 (value accepted into the in-memory store)");
    assert(!postHtml.includes(SECRET), "confirmation page echoes NO value back");

    // === STEP 4 — Agent uses it (placeholder → real value at the boundary)
    section("Agent uses the secret  (before_tool_call swaps {{secret:<key>}} → real value)");
    const beforeToolCall = hook(hooks, "before_tool_call");
    const paramsBefore = {
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer {{secret:${key}}}` },
    };
    block("Params the MODEL emits (placeholder, no value)", JSON.stringify(paramsBefore, null, 2));
    const swapped = beforeToolCall({ toolName: "http_request", params: paramsBefore });
    const paramsAfter = swapped && swapped.params;
    block("Params the TOOL receives at execution (real value injected)", JSON.stringify(paramsAfter, null, 2));
    note("\n  ^ This is what the tool actually executes with. The model never saw this — it");
    note("    only ever handled the {{secret:<key>}} placeholder.");
    assert(
      paramsAfter && paramsAfter.headers.Authorization === `Bearer ${SECRET}`,
      "Authorization header now carries the REAL value at the tool boundary",
    );
    assert(
      paramsAfter && paramsAfter.url === paramsBefore.url,
      "non-placeholder fields (url) are untouched",
    );

    // === STEP 5 — Single-use (use-once: second use is blocked) ==========
    section("Single-use  (use-once: the SAME placeholder is now blocked — value wiped on first use)");
    const blocked = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${key}}}` } },
    });
    block("before_tool_call result", JSON.stringify(blocked, null, 2));
    assert(blocked && blocked.block === true, "second use is BLOCKED (use-once value already wiped)");
    assert(blocked && typeof blocked.blockReason === "string" && blocked.blockReason.includes(key),
      "block reason names the key (and leaks no value)");
    assert(!(blocked && "params" in blocked), "a blocked call returns no rewritten params");

    // === STEP 6 — Backstop (message_sending redacts a live accidental echo)
    section("Backstop  (message_sending redacts an accidental echo of a LIVE value)");
    note("  The use-once value above is already gone, so to demonstrate the output backstop");
    note("  we mint a SESSION-lifetime secret (which survives) and submit a value for it,");
    note("  then show an accidental echo getting scrubbed before it could be sent.");
    const sessMinted = await tool.execute("call-2", { label: "Postgres password", lifetime: "session" });
    const sessDetails = /** @type {{ key: string, link: string, lifetime: string }} */ (sessMinted.details);
    assert(sessDetails.lifetime === "session", "second secret minted with session lifetime");
    const sessLink = sessDetails.link;
    const SESSION_SECRET = "pg-LIVE-secret-9876543210";
    const sessPost = await fetch(sessLink, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(SESSION_SECRET)}`,
    });
    await sessPost.text();
    assert(sessPost.status === 200, "session secret submitted out-of-band (HTTP 200)");

    const messageSending = hook(hooks, "message_sending");
    const echoed = `Here is the key you gave me: ${SESSION_SECRET} — using it now.`;
    block("Outbound content BEFORE backstop (oops, value echoed)", echoed);
    const redacted = messageSending({ to: "user", content: echoed });
    block("Outbound content AFTER backstop", redacted && redacted.content);
    assert(redacted && typeof redacted.content === "string", "backstop rewrote the outbound content");
    assert(redacted && !redacted.content.includes(SESSION_SECRET), "live value was redacted from the outbound message");
    assert(redacted && redacted.content.includes("[redacted-secret]"), "redaction marker substituted in its place");

    // Session secret can resolve more than once; then session_end wipes it.
    const sessSwap = beforeToolCall({
      toolName: "http_request",
      params: { headers: { Authorization: `Bearer {{secret:${sessDetails.key}}}` } },
    });
    assert(
      sessSwap && sessSwap.params && sessSwap.params.headers.Authorization === `Bearer ${SESSION_SECRET}`,
      "session secret resolves at the boundary (and survives — not use-once)",
    );
    const sessionEnd = hook(hooks, "session_end");
    sessionEnd({ sessionId: "demo-session" });
    const afterEnd = messageSending({ to: "user", content: echoed });
    assert(afterEnd === undefined, "after session_end the value is wiped — backstop now finds nothing to redact");

    // === STEP 7 — No leak (scan every captured log line) =================
    section("No leak  (the secret value never appeared in ANY log line)");
    const logDump = JSON.stringify(logs);
    block("Every log line the plugin emitted", logs.map((l) => `[${l.level}] ${l.message}`).join("\n") || "(none)");
    assert(!logDump.includes(SECRET), "use-once value never appears in any log line");
    assert(!logDump.includes(SESSION_SECRET), "session value never appears in any log line");
    assert(
      logs.length === 1 && logs[0].level === "info" && logs[0].message === "secret-tunnel registered",
      "the ONLY thing logged is the static registration fact",
    );

    // === Done ============================================================
    console.log(`\n${"#".repeat(78)}`);
    console.log(`#  DEMO PASSED — ${assertions} assertions held across ${stepNo} steps.`);
    console.log("#  The model saw a key + a link; the human supplied the value out-of-band;");
    console.log("#  the value was injected only at the tool boundary, used once, then wiped.");
    console.log(`${"#".repeat(78)}\n`);
  } catch (err) {
    exitCode = 1;
    console.error(`\n${"#".repeat(78)}`);
    console.error("#  DEMO FAILED");
    console.error(`#  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`${"#".repeat(78)}\n`);
  } finally {
    await gw.close().catch(() => {});
  }

  process.exit(exitCode);
}

/** Convert an absolute fs path to a file:// URL for dynamic import on all OSes. */
function pathToUrl(p) {
  return new URL(`file://${p.startsWith("/") ? "" : "/"}${p}`).href;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
