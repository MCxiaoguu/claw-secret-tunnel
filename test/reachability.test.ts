import { describe, it, expect, vi } from "vitest";
import { resolveBaseUrl } from "../src/reachability.js";
import { DEFAULT_CONFIG, type SecretTunnelConfig } from "../src/types.js";

function cfg(overrides: Partial<SecretTunnelConfig> = {}): SecretTunnelConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("resolveBaseUrl", () => {
  it("uses config.publicUrl when set, with no warning", () => {
    const out = resolveBaseUrl(cfg({ publicUrl: "https://funnel.example.ts.net" }));
    expect(out.url).toBe("https://funnel.example.ts.net");
    expect(out.warning).toBeUndefined();
  });

  it("strips a trailing slash from publicUrl", () => {
    const out = resolveBaseUrl(cfg({ publicUrl: "https://funnel.example.ts.net/" }));
    expect(out.url).toBe("https://funnel.example.ts.net");
    expect(out.warning).toBeUndefined();
  });

  it("publicUrl wins even when detectTailscale is true (does not call the detector)", () => {
    const getTailscaleDnsName = vi.fn(() => "should-not-be-used.ts.net.");
    const out = resolveBaseUrl(cfg({ publicUrl: "https://set.example.com", detectTailscale: true }), {
      getTailscaleDnsName,
    });
    expect(out.url).toBe("https://set.example.com");
    expect(out.warning).toBeUndefined();
    expect(getTailscaleDnsName).not.toHaveBeenCalled();
  });

  it("uses the Tailscale DNS name (https, trailing dot stripped) when publicUrl unset", () => {
    const getTailscaleDnsName = vi.fn(() => "host.tail1234.ts.net.");
    const out = resolveBaseUrl(cfg({ detectTailscale: true }), { getTailscaleDnsName });
    expect(out.url).toBe("https://host.tail1234.ts.net");
    expect(out.warning).toBeUndefined();
    expect(getTailscaleDnsName).toHaveBeenCalledTimes(1);
  });

  it("falls back to localhost + warning when tailscale detection returns undefined", () => {
    const getTailscaleDnsName = vi.fn(() => undefined);
    const out = resolveBaseUrl(cfg({ detectTailscale: true }), { getTailscaleDnsName });
    expect(out.url).toBe("http://127.0.0.1:18789");
    expect(out.warning).toBeTruthy();
    expect(out.warning).toMatch(/publicUrl|Tailscale/i);
    expect(getTailscaleDnsName).toHaveBeenCalledTimes(1);
  });

  it("does NOT call the detector when detectTailscale is false, and warns on localhost", () => {
    const getTailscaleDnsName = vi.fn(() => "host.tail1234.ts.net.");
    const out = resolveBaseUrl(cfg({ detectTailscale: false }), { getTailscaleDnsName });
    expect(out.url).toBe("http://127.0.0.1:18789");
    expect(out.warning).toBeTruthy();
    expect(getTailscaleDnsName).not.toHaveBeenCalled();
  });

  it("honors a custom port for the localhost fallback", () => {
    const out = resolveBaseUrl(cfg({ detectTailscale: false }), { port: 4567 });
    expect(out.url).toBe("http://127.0.0.1:4567");
    expect(out.warning).toBeTruthy();
  });

  it("defaults the localhost port to 18789 when none is provided", () => {
    const out = resolveBaseUrl(cfg({ detectTailscale: false }));
    expect(out.url).toBe("http://127.0.0.1:18789");
  });
});
