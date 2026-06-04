import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { fakeApi } from "./fakeApi.js";

/** Parse the on-disk manifest the real gateway loads (drift guard source of truth). */
function readManifest(): Record<string, unknown> {
  const manifestPath = fileURLToPath(
    new URL("../openclaw.plugin.json", import.meta.url),
  );
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

describe("index — plugin wiring", () => {
  it("default-exports a plugin with the expected identity fields", () => {
    expect(plugin.id).toBe("secret-tunnel");
    expect(plugin.name).toBe("One-Time Secret Tunnel");
    expect(plugin.version).toBe("0.1.0");
    expect(typeof plugin.description).toBe("string");
    expect((plugin.description as string).length).toBeGreaterThan(0);
    expect(typeof plugin.register).toBe("function");
  });

  it("registers exactly one tool, named request_secret", () => {
    const { api, tools } = fakeApi();
    plugin.register(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_secret");
  });

  it("registers exactly one http route at the default path /secret", () => {
    const { api, routes } = fakeApi();
    plugin.register(api);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/secret");
    expect(typeof routes[0].handler).toBe("function");
  });

  it("registers handlers for all six lifecycle/redaction hooks", () => {
    const { api, hooks } = fakeApi();
    plugin.register(api);
    for (const name of [
      "before_tool_call",
      "after_tool_call",
      "message_sending",
      "tool_result_persist",
      "session_end",
      "gateway_stop",
    ]) {
      expect(hooks[name], `hook ${name} should be registered`).toBeDefined();
      expect(hooks[name].length).toBeGreaterThanOrEqual(1);
    }
  });

  it("configSchema is an object and deep-equals the on-disk manifest configSchema", () => {
    const manifest = readManifest();
    expect((plugin.configSchema as { type?: unknown }).type).toBe("object");
    expect(plugin.configSchema).toEqual(manifest.configSchema);
  });

  it("manifest id equals the plugin id", () => {
    const manifest = readManifest();
    expect(manifest.id).toBe(plugin.id);
  });

  it("merges a valid pluginConfig: routePath override flows to the registered route", () => {
    const { api, routes } = fakeApi({
      pluginConfig: { routePath: "/creds", defaultLifetime: "session" },
    });
    plugin.register(api);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/creds");
  });

  it("ignores a bogus pluginConfig without throwing and falls back to /secret", () => {
    const { api, routes } = fakeApi({
      // routePath wrong type, defaultLifetime not a valid literal.
      pluginConfig: { routePath: 123, defaultLifetime: "nope" } as never,
    });
    expect(() => plugin.register(api)).not.toThrow();
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe("/secret");
  });

  it("does not throw when pluginConfig is entirely absent", () => {
    const { api, routes } = fakeApi({ pluginConfig: undefined });
    expect(() => plugin.register(api)).not.toThrow();
    expect(routes[0].path).toBe("/secret");
  });

  it("loadConfig honours a normal routePath but fails safe on one containing '?'", () => {
    // A clean path is adopted as-is.
    expect(loadConfig({ routePath: "/creds" }).routePath).toBe("/creds");
    // A routePath carrying a query can't round-trip as a dispatch pathname, so
    // it must fall back to the default rather than mint links that always 404.
    expect(loadConfig({ routePath: "/x?y" }).routePath).toBe("/secret");
  });

  it("captured session_end and gateway_stop hooks run without throwing", () => {
    const { api, hooks } = fakeApi();
    plugin.register(api);
    const sessionEnd = hooks["session_end"][0] as (e: unknown) => unknown;
    const gatewayStop = hooks["gateway_stop"][0] as (e: unknown) => unknown;
    expect(() => sessionEnd({ sessionId: "s1" })).not.toThrow();
    expect(() => gatewayStop({ reason: "shutdown" })).not.toThrow();
  });
});
