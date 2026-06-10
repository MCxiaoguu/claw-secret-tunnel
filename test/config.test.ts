import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("config — tunnel provider", () => {
  it("defaults tunnel to \"cloudflared\"", () => {
    expect(DEFAULT_CONFIG.tunnel).toBe("cloudflared");
    expect(loadConfig(undefined).tunnel).toBe("cloudflared");
    expect(loadConfig({}).tunnel).toBe("cloudflared");
  });

  it("defaults detectTailscale to false (tailscale reachability is opt-in)", () => {
    expect(DEFAULT_CONFIG.detectTailscale).toBe(false);
    expect(loadConfig({}).detectTailscale).toBe(false);
  });

  it("adopts the known tunnel literals", () => {
    expect(loadConfig({ tunnel: "off" }).tunnel).toBe("off");
    expect(loadConfig({ tunnel: "cloudflared" }).tunnel).toBe("cloudflared");
  });

  it("falls back to the default on an unknown/garbage tunnel value", () => {
    expect(loadConfig({ tunnel: "ngrok" }).tunnel).toBe("cloudflared");
    expect(loadConfig({ tunnel: 123 }).tunnel).toBe("cloudflared");
    expect(loadConfig({ tunnel: null }).tunnel).toBe("cloudflared");
    expect(loadConfig({ tunnel: "" }).tunnel).toBe("cloudflared");
  });

  it("still honours an explicit detectTailscale: true", () => {
    expect(loadConfig({ detectTailscale: true }).detectTailscale).toBe(true);
  });
});
