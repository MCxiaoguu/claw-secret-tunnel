import { DEFAULT_CONFIG, type Lifetime, type VanisherConfig } from "./types.js";

/**
 * Defensive config loader.
 *
 * Merges the operator-supplied `api.pluginConfig` (sourced from
 * `openclaw.yaml` → `plugins.entries["credential-vanisher"].config`, already
 * loosely validated against the manifest `configSchema`, but NOT something we
 * trust) over {@link DEFAULT_CONFIG}.
 *
 * Posture: NEVER throws. Every field is independently validated and an invalid
 * value silently falls back to its default, so a malformed config can degrade
 * behaviour but can never crash `register`. Unknown keys are ignored entirely
 * (we read by name, not by spreading), which mirrors the manifest's
 * `additionalProperties: false`.
 */

const LIFETIMES: readonly Lifetime[] = ["use-once", "session", "ttl"];

function isLifetime(value: unknown): value is Lifetime {
  return typeof value === "string" && (LIFETIMES as readonly string[]).includes(value);
}

/** A usable port/seconds number: finite and strictly positive. */
function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function loadConfig(raw: unknown): VanisherConfig {
  // Start from a fresh copy of the defaults so we never mutate the shared const.
  const config: VanisherConfig = { ...DEFAULT_CONFIG };

  if (raw === null || typeof raw !== "object") {
    return config;
  }
  const input = raw as Record<string, unknown>;

  // publicUrl: optional; only adopt a non-empty (trimmed) string. Anything else
  // (including an empty/whitespace string) leaves it unset → reachability falls
  // back to Tailscale/localhost.
  if (typeof input.publicUrl === "string" && input.publicUrl.trim().length > 0) {
    config.publicUrl = input.publicUrl;
  }

  // detectTailscale: only override on an actual boolean.
  if (typeof input.detectTailscale === "boolean") {
    config.detectTailscale = input.detectTailscale;
  }

  // defaultLifetime: only one of the three known literals.
  if (isLifetime(input.defaultLifetime)) {
    config.defaultLifetime = input.defaultLifetime;
  }

  // ttlSeconds / linkExpirySeconds: finite positive numbers only.
  if (finitePositive(input.ttlSeconds)) {
    config.ttlSeconds = input.ttlSeconds;
  }
  if (finitePositive(input.linkExpirySeconds)) {
    config.linkExpirySeconds = input.linkExpirySeconds;
  }

  // routePath: a non-empty string that looks like an absolute path. We normalise
  // to a leading "/" and strip any trailing slash so it composes cleanly with the
  // intake handler and the minted link. A blank/garbage value keeps the default.
  //
  // Fail-safe: the path is registered for EXACT-match dispatch on `url.pathname`,
  // but the minted link is `<routePath>?token=...`. A value carrying a query
  // ("?"), fragment ("#"), or whitespace can't round-trip as a pathname (e.g.
  // "/x?y" registers literally but the gateway dispatches on pathname "/x", so
  // every link 404s). Reject such values and keep the default instead.
  if (typeof input.routePath === "string" && !/[?#\s]/.test(input.routePath)) {
    const trimmed = input.routePath.trim();
    if (trimmed.length > 0) {
      const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
      const normalised =
        withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
      if (normalised.length > 0) {
        config.routePath = normalised;
      }
    }
  }

  return config;
}
