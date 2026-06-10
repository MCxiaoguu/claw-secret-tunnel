import type { OpenClawPlugin, OpenClawPluginApi } from "./openclaw.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./store.js";
import { CloudflaredTunnel, createBaseUrlProvider } from "./tunnel.js";
import { createRequestSecretTool } from "./request-tool.js";
import { createIntakeHandler } from "./intake.js";
import { createBeforeToolCall, createAfterToolCall } from "./resolver.js";
import { createMessageSending, createToolResultPersist } from "./redact.js";

/**
 * One-Time Secret Tunnel — plugin entry point.
 *
 * This is the surface the real OpenClaw gateway loads (`package.json#openclaw`
 * → `./dist/index.js`). `register` wires the six independently-tested units into
 * the gateway:
 *   - the `request_secret` tool (mints the one-time link + key),
 *   - the HTTP intake route (captures the value out-of-band, never logged),
 *   - the `before_tool_call`/`after_tool_call` resolver (`{{secret:<key>}}` swap),
 *   - the `message_sending`/`tool_result_persist` redaction backstop,
 *   - `session_end`/`gateway_stop` lifecycle wipes.
 *
 * No secret VALUE is ever held, logged, or returned by anything wired here — the
 * value lives only inside {@link SecretStore} in memory and is wiped per its
 * lifetime (see spec §5/§8/§11).
 */

/**
 * The plugin config JSON Schema. Defined ONCE here and asserted (in the tests)
 * to deep-equal the on-disk `openclaw.plugin.json#configSchema`, so the manifest
 * the gateway validates against and the schema the code advertises can never
 * drift apart. Keep these properties in lockstep with {@link SecretTunnelConfig}.
 */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    publicUrl: { type: "string" },
    detectTailscale: { type: "boolean", default: false },
    tunnel: {
      type: "string",
      enum: ["cloudflared", "off"],
      default: "cloudflared",
    },
    defaultLifetime: {
      type: "string",
      enum: ["use-once", "session", "ttl"],
      default: "use-once",
    },
    ttlSeconds: { type: "number", default: 300 },
    linkExpirySeconds: { type: "number", default: 600 },
    routePath: { type: "string", default: "/secret" },
  },
} as const;

const plugin: OpenClawPlugin = {
  id: "secret-tunnel",
  name: "ClawTunnel",
  description:
    "One-time, never-stored, out-of-band credential pass-through. The agent never sees the value.",
  version: "0.1.2",
  configSchema: configSchema as unknown as Record<string, unknown>,

  register(api: OpenClawPluginApi): void {
    // 1. Resolve effective config defensively (never throws on bad input).
    const config = loadConfig(api.pluginConfig);

    // 2. The single in-memory, ephemeral secret store.
    const store = new SecretStore(config);

    // 2b. On-demand Cloudflare quick-tunnel manager (the default reachability
    //     fallback). Construction is lazy — nothing spawns until a link is
    //     actually minted with no publicUrl/Tailscale reachability.
    const tunnel = new CloudflaredTunnel();

    // 3. The agent-facing tool. No `deliver` for now — direct-channel send is
    //    deferred; the agent relays the minted link verbatim (spec §10/§16).
    api.registerTool(
      createRequestSecretTool({
        store,
        getBaseUrl: createBaseUrlProvider({ config, tunnel }),
        routePath: config.routePath,
        defaultLifetime: config.defaultLifetime,
      }),
    );

    // 4. The HTTP intake route (GET form + POST capture) at the configured path.
    api.registerHttpRoute({
      path: config.routePath,
      handler: createIntakeHandler(store, config.routePath),
    });

    // 5. Resolver: swap `{{secret:<key>}}` for the live value at point-of-use.
    api.on("before_tool_call", createBeforeToolCall(store));
    api.on("after_tool_call", createAfterToolCall(store));

    // 6. Redaction backstop on outbound + persisted output.
    api.on("message_sending", createMessageSending(store));
    api.on("tool_result_persist", createToolResultPersist(store));

    // 7. Lifecycle wipes (+ tunnel teardown so no public route outlives the gateway).
    api.on("session_end", () => store.endSession());
    api.on("gateway_stop", () => {
      store.clearAll();
      tunnel.stop();
    });

    // Minimal, value-free startup log. We deliberately log NOTHING derived from
    // a captured secret; only the static registration fact.
    api.logger.info("secret-tunnel registered");
  },
};

export default plugin;
