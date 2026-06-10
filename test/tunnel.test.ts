import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  CloudflaredTunnel,
  createBaseUrlProvider,
  TUNNEL_STOP_GRACE_MS,
  type SpawnLike,
} from "../src/tunnel.js";
import { DEFAULT_CONFIG, type SecretTunnelConfig } from "../src/types.js";

/**
 * Fake child process: just enough of the ChildProcess surface for the manager
 * (stdout/stderr data events, "error"/"exit", kill). Mirrors the injectable
 * style of reachability's getTailscaleDnsName seam — tests never spawn anything.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: string[] = [];
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }
}

/** The stderr banner real cloudflared prints once the quick tunnel is live. */
function banner(url: string): string {
  return [
    "2026-06-10T12:00:00Z INF Thank you for trying Cloudflare Tunnel.",
    "2026-06-10T12:00:01Z INF +--------------------------------------------+",
    "2026-06-10T12:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
    `2026-06-10T12:00:01Z INF |  ${url}  |`,
    "2026-06-10T12:00:01Z INF +--------------------------------------------+",
  ].join("\n");
}

const URL_A = "https://island-waste-cathedral.trycloudflare.com";
const LEASE_MS = 630_000; // linkExpiry 600s + 30s grace

function makeTunnel(overrides: {
  spawned?: FakeChild[];
  port?: number;
  readyTimeoutMs?: number;
} = {}) {
  const spawned = overrides.spawned ?? [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnImpl: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    spawned.push(child);
    return child;
  };
  const tunnel = new CloudflaredTunnel({
    port: overrides.port,
    readyTimeoutMs: overrides.readyTimeoutMs,
    spawnImpl,
  });
  return { tunnel, calls, spawned };
}

describe("CloudflaredTunnel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` and resolves the URL from the stderr banner", async () => {
    const { tunnel, calls, spawned } = makeTunnel({ port: 4242 });
    const pending = tunnel.ensureUrl(LEASE_MS);
    expect(calls).toEqual([
      {
        command: "cloudflared",
        args: ["tunnel", "--url", "http://127.0.0.1:4242", "--no-autoupdate"],
      },
    ]);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await expect(pending).resolves.toBe(URL_A);
  });

  it("defaults the target port to 18789", async () => {
    const { tunnel, calls, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    expect(calls[0].args).toContain("http://127.0.0.1:18789");
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await pending;
  });

  it("also accepts the URL on stdout (defensive against output-stream changes)", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stdout.emit("data", Buffer.from(`visit ${URL_A} now`));
    await expect(pending).resolves.toBe(URL_A);
  });

  it("parses a URL split across chunk boundaries", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    const text = banner(URL_A);
    const mid = text.indexOf(".trycloudflare.com") - 4;
    spawned[0].stderr.emit("data", Buffer.from(text.slice(0, mid)));
    spawned[0].stderr.emit("data", Buffer.from(text.slice(mid)));
    await expect(pending).resolves.toBe(URL_A);
  });

  it("reuses the running tunnel: a second ensureUrl returns the same URL without spawning again", async () => {
    const { tunnel, calls, spawned } = makeTunnel();
    const first = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await first;
    await expect(tunnel.ensureUrl(LEASE_MS)).resolves.toBe(URL_A);
    expect(calls).toHaveLength(1);
  });

  it("dedupes concurrent ensureUrl calls during startup into one spawn", async () => {
    const { tunnel, calls, spawned } = makeTunnel();
    const a = tunnel.ensureUrl(LEASE_MS);
    const b = tunnel.ensureUrl(LEASE_MS);
    expect(calls).toHaveLength(1);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await expect(a).resolves.toBe(URL_A);
    await expect(b).resolves.toBe(URL_A);
  });

  it("resolves undefined when spawn errors (cloudflared binary missing) — never throws", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    spawned[0].emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }));
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves undefined when the process exits before printing a URL", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from("failed to fetch quick tunnel: dial tcp: i/o timeout\n"));
    spawned[0].emit("exit", 1, null);
    await expect(pending).resolves.toBeUndefined();
  });

  it("times out (kills the child, resolves undefined) when no URL appears within readyTimeoutMs", async () => {
    const { tunnel, spawned } = makeTunnel({ readyTimeoutMs: 5_000 });
    const pending = tunnel.ensureUrl(LEASE_MS);
    vi.advanceTimersByTime(5_001);
    await expect(pending).resolves.toBeUndefined();
    expect(spawned[0].kills).toContain("SIGTERM");
  });

  it("after a failed start, a later ensureUrl tries a fresh spawn", async () => {
    const { tunnel, calls, spawned } = makeTunnel();
    const first = tunnel.ensureUrl(LEASE_MS);
    spawned[0].emit("error", new Error("spawn cloudflared ENOENT"));
    await first;
    const second = tunnel.ensureUrl(LEASE_MS);
    expect(calls).toHaveLength(2);
    spawned[1].stderr.emit("data", Buffer.from(banner(URL_A)));
    await expect(second).resolves.toBe(URL_A);
  });

  it("SIGTERMs the child once the lease window has fully elapsed", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await pending;
    vi.advanceTimersByTime(LEASE_MS - 1);
    expect(spawned[0].kills).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(spawned[0].kills).toContain("SIGTERM");
  });

  it("a later ensureUrl extends the lease past the original deadline", async () => {
    const { tunnel, spawned } = makeTunnel();
    const first = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await first;

    // Half-way through, a second link takes a fresh lease.
    vi.advanceTimersByTime(LEASE_MS / 2);
    await expect(tunnel.ensureUrl(LEASE_MS)).resolves.toBe(URL_A);

    // The original deadline passes — the tunnel must STILL be up.
    vi.advanceTimersByTime(LEASE_MS / 2 + 1);
    expect(spawned[0].kills).toHaveLength(0);

    // The extended deadline passes — now it stops.
    vi.advanceTimersByTime(LEASE_MS / 2 + 1);
    expect(spawned[0].kills).toContain("SIGTERM");
  });

  it("after a lease-driven stop, the next ensureUrl spawns a fresh tunnel with the fresh URL", async () => {
    const URL_B = "https://brand-new-words.trycloudflare.com";
    const { tunnel, calls, spawned } = makeTunnel();
    const first = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await first;
    vi.advanceTimersByTime(LEASE_MS + 1);
    expect(spawned[0].kills).toContain("SIGTERM");

    const second = tunnel.ensureUrl(LEASE_MS);
    expect(calls).toHaveLength(2);
    spawned[1].stderr.emit("data", Buffer.from(banner(URL_B)));
    await expect(second).resolves.toBe(URL_B);
  });

  it("forgets a tunnel that dies unexpectedly after ready, and respawns on the next ensureUrl", async () => {
    const URL_B = "https://resurrected-tunnel.trycloudflare.com";
    const { tunnel, calls, spawned } = makeTunnel();
    const first = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await first;

    spawned[0].emit("exit", 1, null); // crash after ready

    const second = tunnel.ensureUrl(LEASE_MS);
    expect(calls).toHaveLength(2);
    spawned[1].stderr.emit("data", Buffer.from(banner(URL_B)));
    await expect(second).resolves.toBe(URL_B);
  });

  it("stop() during startup resolves the pending ensureUrl to undefined (no link on a dead tunnel)", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    tunnel.stop(); // e.g. gateway_stop racing a slow start
    // The banner arrives after the kill — it must NOT resurrect the URL.
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await expect(pending).resolves.toBeUndefined();
    expect(spawned[0].kills).toContain("SIGTERM");
  });

  it("stop() kills the running child and is idempotent", async () => {
    const { tunnel, spawned } = makeTunnel();
    const pending = tunnel.ensureUrl(LEASE_MS);
    spawned[0].stderr.emit("data", Buffer.from(banner(URL_A)));
    await pending;
    tunnel.stop();
    tunnel.stop();
    expect(spawned[0].kills).toEqual(["SIGTERM"]);
  });
});

describe("createBaseUrlProvider", () => {
  const TUNNEL_URL = "https://island-waste-cathedral.trycloudflare.com";

  function cfg(overrides: Partial<SecretTunnelConfig> = {}): SecretTunnelConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
  }

  function fakeTunnel(url: string | undefined) {
    return { ensureUrl: vi.fn(async (_leaseMs: number) => url) };
  }

  it("publicUrl wins and the tunnel is never consulted", async () => {
    const tunnel = fakeTunnel(TUNNEL_URL);
    const getBaseUrl = createBaseUrlProvider({
      config: cfg({ publicUrl: "https://gw.example.com" }),
      tunnel,
    });
    await expect(getBaseUrl()).resolves.toEqual({ url: "https://gw.example.com" });
    expect(tunnel.ensureUrl).not.toHaveBeenCalled();
  });

  it("any no-warning static resolution (e.g. Tailscale) wins over the tunnel", async () => {
    const tunnel = fakeTunnel(TUNNEL_URL);
    const getBaseUrl = createBaseUrlProvider({
      config: cfg(),
      tunnel,
      resolveStatic: () => ({ url: "https://host.tailnet.ts.net" }),
    });
    await expect(getBaseUrl()).resolves.toEqual({ url: "https://host.tailnet.ts.net" });
    expect(tunnel.ensureUrl).not.toHaveBeenCalled();
  });

  it("starts the quick tunnel on the localhost fallback, with a lease of linkExpiry + grace", async () => {
    const tunnel = fakeTunnel(TUNNEL_URL);
    const getBaseUrl = createBaseUrlProvider({
      config: cfg({ linkExpirySeconds: 600 }),
      tunnel,
    });
    await expect(getBaseUrl()).resolves.toEqual({ url: TUNNEL_URL });
    expect(tunnel.ensureUrl).toHaveBeenCalledWith(600_000 + TUNNEL_STOP_GRACE_MS);
  });

  it("falls back to localhost + a warning naming cloudflared when the tunnel fails", async () => {
    const tunnel = fakeTunnel(undefined);
    const getBaseUrl = createBaseUrlProvider({ config: cfg(), tunnel });
    const out = await getBaseUrl();
    expect(out.url).toBe("http://127.0.0.1:18789");
    expect(out.warning).toMatch(/cloudflared/i);
    expect(out.warning).toMatch(/publicUrl|Tailscale/i);
  });

  it("tunnel \"off\" keeps the plain localhost warning and never consults the tunnel", async () => {
    const tunnel = fakeTunnel(TUNNEL_URL);
    const getBaseUrl = createBaseUrlProvider({
      config: cfg({ tunnel: "off" }),
      tunnel,
    });
    const out = await getBaseUrl();
    expect(out.url).toBe("http://127.0.0.1:18789");
    expect(out.warning).toBeTruthy();
    expect(out.warning).not.toMatch(/cloudflared/i);
    expect(tunnel.ensureUrl).not.toHaveBeenCalled();
  });

  it("honors a custom gateway port in the localhost fallback", async () => {
    const tunnel = fakeTunnel(undefined);
    const getBaseUrl = createBaseUrlProvider({
      config: cfg(),
      tunnel,
      port: 4567,
    });
    const out = await getBaseUrl();
    expect(out.url).toBe("http://127.0.0.1:4567");
  });
});
