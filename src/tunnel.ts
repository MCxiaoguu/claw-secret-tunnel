import { spawn } from "node:child_process";
import { resolveBaseUrl } from "./reachability.js";
import type { SecretTunnelConfig } from "./types.js";

/**
 * On-demand Cloudflare Quick Tunnel manager — the zero-config reachability
 * fallback. `request_secret` calls {@link CloudflaredTunnel.ensureUrl} with a
 * lease covering the link's lifetime; the manager spawns
 * `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`, parses
 * the public `https://*.trycloudflare.com` URL from its output, and keeps the
 * process alive only while at least one minted link could still be opened.
 * When the last lease lapses the child is SIGTERMed, so the gateway is
 * publicly reachable only in a bounded window around each hand-off.
 *
 * Posture (mirrors reachability.ts):
 * - NEVER throws and never rejects: any failure (missing binary, early exit,
 *   ready timeout) resolves `undefined` so the caller can fall back to the
 *   localhost warning path.
 * - The spawn is injectable so tests never launch a real process.
 * - All timers are unref'd; the manager never keeps the process alive.
 * - Nothing secret is ever handled here — only the public tunnel URL, which is
 *   relayed to the human over chat anyway.
 */

/** Structural slice of ChildProcess the manager needs (testable surface). */
export type ChildLike = {
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};
export type SpawnLike = (command: string, args: string[]) => ChildLike;

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const DEFAULT_PORT = 18789;
const DEFAULT_READY_TIMEOUT_MS = 20_000;

/** Default spawn: stdio piped, detached=false; stdin ignored. */
function defaultSpawn(command: string, args: string[]): ChildLike {
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

export type CloudflaredTunnelOptions = {
  /** Local gateway port the tunnel forwards to. Defaults to 18789. */
  port?: number;
  /** cloudflared executable (PATH lookup applies). Defaults to "cloudflared". */
  command?: string;
  /** Injectable spawner so tests never launch a real binary. */
  spawnImpl?: SpawnLike;
  /** How long to wait for the public URL before giving up. Default 20s. */
  readyTimeoutMs?: number;
};

export class CloudflaredTunnel {
  private readonly port: number;
  private readonly command: string;
  private readonly spawnImpl: SpawnLike;
  private readonly readyTimeoutMs: number;

  private child?: ChildLike;
  private url?: string;
  private starting?: Promise<string | undefined>;
  private stopAt = 0;
  private stopTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: CloudflaredTunnelOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.command = opts.command ?? "cloudflared";
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /**
   * Ensure a quick tunnel is up and return its public base URL, extending the
   * keep-alive lease by `leaseMs` from now. Resolves `undefined` on any
   * failure — callers fall back to the localhost warning path.
   */
  ensureUrl(leaseMs: number): Promise<string | undefined> {
    this.extendLease(leaseMs);
    if (this.url !== undefined && this.child !== undefined) {
      return Promise.resolve(this.url);
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start();
    return this.starting;
  }

  /** Kill the child (if any) and forget all state. Safe to call repeatedly. */
  stop(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.starting = undefined;
    this.stopAt = 0;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone — nothing to do
      }
    }
  }

  /** Bump the stop deadline to at least `now + leaseMs` and (re)arm the timer. */
  private extendLease(leaseMs: number): void {
    const target = Date.now() + Math.max(0, leaseMs);
    if (target > this.stopAt) {
      this.stopAt = target;
    }
    this.armStopTimer();
  }

  /** One unref'd timer that fires at `stopAt`; re-arms itself if extended. */
  private armStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }
    const delay = Math.max(0, this.stopAt - Date.now());
    const timer = setTimeout(() => {
      this.stopTimer = undefined;
      if (Date.now() >= this.stopAt) {
        this.stop();
      } else {
        this.armStopTimer();
      }
    }, delay);
    timer.unref?.();
    this.stopTimer = timer;
  }

  /** Spawn cloudflared and resolve the public URL (or undefined). Never rejects. */
  private start(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      let child: ChildLike;
      try {
        child = this.spawnImpl(this.command, [
          "tunnel",
          "--url",
          `http://127.0.0.1:${this.port}`,
          "--no-autoupdate",
        ]);
      } catch {
        this.starting = undefined;
        resolve(undefined);
        return;
      }
      this.child = child;

      let settled = false;
      let buffer = "";

      const readyTimer = setTimeout(() => fail(), this.readyTimeoutMs);
      readyTimer.unref?.();

      const succeed = (url: string) => {
        if (settled) return;
        // Disowned mid-start (stop() raced us): the child is already being
        // killed — don't hand out a URL on a dead tunnel.
        if (this.child !== child) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(readyTimer);
        this.url = url;
        this.starting = undefined;
        resolve(url);
      };

      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        // Reset only if this attempt still owns the slot (a later start may not).
        if (this.child === child) {
          this.stop();
        }
        resolve(undefined);
      };

      const onData = (chunk: unknown) => {
        if (settled) return;
        buffer += String(chunk);
        const match = buffer.match(QUICK_TUNNEL_URL);
        if (match) {
          succeed(match[0]);
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", () => fail());
      child.on("exit", () => {
        if (!settled) {
          fail();
          return;
        }
        // Unexpected death after ready: forget the dead tunnel so the next
        // ensureUrl respawns a fresh one (with a fresh URL).
        if (this.child === child) {
          this.child = undefined;
          this.url = undefined;
          this.starting = undefined;
        }
      });
    });
  }
}

/**
 * Keep the tunnel up a little past the link's own expiry so the human's final
 * POST (and the "Received" page) never race the teardown.
 */
export const TUNNEL_STOP_GRACE_MS = 30_000;

const TUNNEL_FAILED_NOTE =
  "Starting a cloudflared quick tunnel also failed — install cloudflared " +
  "(https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) " +
  "and ensure it is on the gateway's PATH, or set tunnel: \"off\".";

/**
 * Build the async base-URL provider `request_secret` uses per call.
 *
 * Precedence:
 *  1. static resolution ({@link resolveBaseUrl}): `publicUrl`, then (opt-in)
 *     Tailscale — any no-warning result wins and the tunnel is never consulted;
 *  2. `tunnel: "cloudflared"` (the default) → an on-demand quick tunnel leased
 *     for the link's lifetime (+ grace);
 *  3. the localhost fallback, with the static warning augmented to say the
 *     tunnel failed too.
 */
export function createBaseUrlProvider(deps: {
  config: SecretTunnelConfig;
  tunnel: Pick<CloudflaredTunnel, "ensureUrl">;
  /** Injectable static resolver (tests); defaults to {@link resolveBaseUrl}. */
  resolveStatic?: typeof resolveBaseUrl;
  /** Gateway port for the localhost fallback (mirrors resolveBaseUrl). */
  port?: number;
}): () => Promise<{ url: string; warning?: string }> {
  const { config, tunnel, port } = deps;
  const resolveStatic = deps.resolveStatic ?? resolveBaseUrl;

  return async () => {
    const staticBase = resolveStatic(config, { port });
    if (!staticBase.warning) {
      return staticBase;
    }
    if (config.tunnel !== "cloudflared") {
      return staticBase;
    }
    const leaseMs = config.linkExpirySeconds * 1000 + TUNNEL_STOP_GRACE_MS;
    const url = await tunnel.ensureUrl(leaseMs);
    if (url) {
      return { url };
    }
    return { url: staticBase.url, warning: `${staticBase.warning} ${TUNNEL_FAILED_NOTE}` };
  };
}
