import type { SecretStore } from "./store.js";
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
} from "./openclaw.js";

/**
 * `{{secret:<key>}}` boundary resolver (spec §7, §8).
 *
 * This is the single injection point where a real secret value enters a tool
 * call. The agent only ever sees the opaque key placeholder `{{secret:<key>}}`;
 * `before_tool_call` swaps it for the live value at the last possible moment,
 * and (for `use-once` lifetimes) the value is wiped by the store the instant it
 * is resolved.
 *
 * Ordering is the security-critical part: we CHECK every referenced key's
 * status (a non-consuming read) before we RESOLVE any of them (a consuming
 * read for use-once secrets). That way a single not-ready placeholder can never
 * burn a sibling one-shot secret that happens to be in the same call.
 */

/** Matches `{{secret:<key>}}`; group 1 is the key (any chars except `}`). */
const SECRET_RE = /\{\{secret:([^}]+)\}\}/g;

export type ResolveOutcome =
  | { kind: "ok"; params: Record<string, unknown>; changed: boolean }
  | { kind: "block"; reason: string };

/** Append every distinct `{{secret:<key>}}` key found in a string into `out`. */
function collectFromString(value: string, out: Set<string>): void {
  // Reset lastIndex defensively: SECRET_RE is a shared /g regex.
  SECRET_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_RE.exec(value)) !== null) {
    out.add(match[1]);
  }
}

/** Deep-walk arbitrary param data, collecting placeholder keys from strings. */
function collectKeys(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    collectFromString(node, out);
  } else if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const v of Object.values(node)) collectKeys(v, out);
  }
}

/**
 * Deep-clone `node`, replacing every `{{secret:<key>}}` in string values using
 * the resolved `values` map. Non-string leaves are copied as-is. The input is
 * never mutated.
 */
function substitute(
  node: unknown,
  values: ReadonlyMap<string, string>,
): unknown {
  if (typeof node === "string") {
    SECRET_RE.lastIndex = 0;
    return node.replace(SECRET_RE, (whole, key: string) => {
      const v = values.get(key);
      // Every distinct key was resolved before we got here, so `v` is defined;
      // fall back to the original token if somehow missing (never expected).
      return v ?? whole;
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => substitute(item, values));
  }
  if (node !== null && typeof node === "object") {
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      clone[k] = substitute(v, values);
    }
    return clone;
  }
  // number | boolean | null | undefined | bigint | symbol | function -> as-is.
  return node;
}

/** Build an actionable, value-free block reason for a not-filled key. */
function blockReason(store: SecretStore, key: string): string {
  if (store.getStatus(key) === "pending") {
    return `Secret "${key}" hasn't been provided yet — ask the user to open the one-time link first.`;
  }
  // undefined (unknown/wiped) | "expired" | "consumed"
  return `Secret "${key}" is unavailable (expired or already used) — request a new one.`;
}

/**
 * Resolve all `{{secret:<key>}}` placeholders in `params`.
 *
 * 1. Collect the DISTINCT set of referenced keys (deep-walk strings).
 * 2. No placeholders → `{ kind:"ok", changed:false }`, params untouched.
 * 3. Check-all-before-consume: if ANY key is not `"filled"`, block now without
 *    resolving (so no use-once sibling is consumed).
 * 4. Resolve each distinct key exactly once (caching `key→value`), which both
 *    handles duplicate placeholders and avoids double-consuming a one-shot.
 * 5. Deep-clone + substitute → `{ kind:"ok", changed:true }`.
 */
export function resolveParams(
  store: SecretStore,
  params: Record<string, unknown>,
): ResolveOutcome {
  const keys = new Set<string>();
  collectKeys(params, keys);

  // (2) Nothing to do.
  if (keys.size === 0) {
    return { kind: "ok", params, changed: false };
  }

  // (3) Check every key's status BEFORE consuming anything.
  for (const key of keys) {
    if (store.getStatus(key) !== "filled") {
      return { kind: "block", reason: blockReason(store, key) };
    }
  }

  // (4) Resolve each distinct key exactly once.
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = store.resolveValue(key);
    if (value === undefined) {
      // Race: a key was "filled" at check time but vanished before resolve.
      return { kind: "block", reason: blockReason(store, key) };
    }
    values.set(key, value);
  }

  // (5) Deep-clone with substitutions; never mutate the input.
  const resolved = substitute(params, values) as Record<string, unknown>;
  return { kind: "ok", params: resolved, changed: true };
}

/**
 * `before_tool_call` hook: swap placeholders for live values.
 * - block       → `{ block:true, blockReason }`
 * - ok, no swap → `undefined` (leave params as-is)
 * - ok, swapped → `{ params }`
 */
export function createBeforeToolCall(
  store: SecretStore,
): (event: BeforeToolCallEvent) => BeforeToolCallResult {
  return (event: BeforeToolCallEvent): BeforeToolCallResult => {
    const outcome = resolveParams(store, event.params);
    if (outcome.kind === "block") {
      return { block: true, blockReason: outcome.reason };
    }
    if (!outcome.changed) {
      return undefined;
    }
    return { params: outcome.params };
  };
}

/**
 * `after_tool_call` hook: intentional no-op. Use-once values are wiped by the
 * store at resolve time (§8), so there is nothing to scrub here. Kept as a stub
 * for symmetry and future metrics.
 */
export function createAfterToolCall(
  _store: SecretStore,
): (event: AfterToolCallEvent) => void {
  return (_event: AfterToolCallEvent): void => {
    /* no-op */
  };
}
