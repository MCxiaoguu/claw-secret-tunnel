import { execFileSync } from "node:child_process";
import type { SecretTunnelConfig } from "./types.js";

/** Default gateway port (mirrors OpenClaw's DEFAULT_GATEWAY_PORT). */
const DEFAULT_GATEWAY_PORT = 18789;

const LOCALHOST_WARNING =
  "Link is only reachable on the gateway host. Set `publicUrl` (e.g. your Tailscale Funnel URL) " +
  "or enable Tailscale so the human can open it remotely.";

export type ResolveBaseUrlOptions = {
  /** Gateway port used for the localhost fallback. Defaults to 18789. */
  port?: number;
  /**
   * Injectable Tailscale DNS-name resolver (so tests never shell out).
   * Returns the tailnet DNS name (possibly with a trailing dot) or `undefined`.
   */
  getTailscaleDnsName?: () => string | undefined;
};

/**
 * Default Tailscale detection: shells out to `tailscale status --json`, parses
 * `Self.DNSName`. Returns `undefined` on ANY error (missing binary, non-zero
 * exit, unparseable JSON, missing field). Mirrors the device-pair extension's
 * detection but kept minimal and synchronous.
 */
export function getTailscaleDnsName(): string | undefined {
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 2000,
    });
    const parsed = JSON.parse(raw) as { Self?: { DNSName?: unknown } };
    const dns = parsed?.Self?.DNSName;
    if (typeof dns === "string" && dns.length > 0) {
      return dns;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the public base URL the intake link should use.
 *
 * Precedence:
 *  1. `config.publicUrl` (trailing `/` stripped) — no warning.
 *  2. `config.detectTailscale` → `getTailscaleDnsName()` → `https://<name>`
 *     (trailing `.` on the DNS name stripped) — no warning.
 *  3. otherwise `http://127.0.0.1:<port>` (port default 18789) WITH a warning
 *     that the link is only reachable on the gateway host.
 */
export function resolveBaseUrl(
  config: SecretTunnelConfig,
  opts: ResolveBaseUrlOptions = {},
): { url: string; warning?: string } {
  // 1. Explicit public URL wins.
  if (typeof config.publicUrl === "string" && config.publicUrl.trim()) {
    return { url: config.publicUrl.trim().replace(/\/+$/, "") };
  }

  // 2. Tailscale detection (only when enabled).
  if (config.detectTailscale) {
    const detect = opts.getTailscaleDnsName ?? getTailscaleDnsName;
    const name = detect();
    if (name && name.trim()) {
      const host = name.trim().replace(/\.$/, "");
      return { url: `https://${host}` };
    }
  }

  // 3. Localhost fallback + warning.
  const port = opts.port ?? DEFAULT_GATEWAY_PORT;
  return { url: `http://127.0.0.1:${port}`, warning: LOCALHOST_WARNING };
}
