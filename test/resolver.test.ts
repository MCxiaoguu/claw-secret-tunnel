import { describe, it, expect } from "vitest";
import { SecretStore } from "../src/store.js";
import { DEFAULT_CONFIG, type Lifetime, type SecretTunnelConfig } from "../src/types.js";
import {
  resolveParams,
  createBeforeToolCall,
  createAfterToolCall,
} from "../src/resolver.js";

function cfg(overrides: Partial<SecretTunnelConfig> = {}): SecretTunnelConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Create + fill a secret, returning the agent-facing key. */
function makeFilled(
  store: SecretStore,
  value: string,
  label = "API Key",
  lifetime?: Lifetime,
): string {
  const { key, token } = store.create(label, lifetime);
  const ok = store.fill(token, value);
  expect(ok).toBe(true);
  expect(store.getStatus(key)).toBe("filled");
  return key;
}

/** Create a pending (un-filled) secret, returning the key. */
function makePending(store: SecretStore, label = "Pending Key"): string {
  const { key } = store.create(label);
  expect(store.getStatus(key)).toBe("pending");
  return key;
}

describe("resolveParams", () => {
  it("swaps a single placeholder in a string param to the real value", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "sk-real-123");
    const out = resolveParams(store, { apiKey: `{{secret:${key}}}` });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.changed).toBe(true);
    expect(out.params).toEqual({ apiKey: "sk-real-123" });
  });

  it("substitutes mixed literal + placeholder text in one string (Bearer ...)", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "tok-xyz");
    const out = resolveParams(store, {
      headers: { Authorization: `Bearer {{secret:${key}}}` },
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.changed).toBe(true);
    expect(out.params).toEqual({ headers: { Authorization: "Bearer tok-xyz" } });
  });

  it("swaps multiple placeholders across nested objects/arrays incl. different keys", () => {
    const store = new SecretStore(cfg());
    const k1 = makeFilled(store, "VAL_ONE", "one");
    const k2 = makeFilled(store, "VAL_TWO", "two");
    const out = resolveParams(store, {
      a: `{{secret:${k1}}}`,
      nested: {
        b: `prefix-{{secret:${k2}}}-suffix`,
        arr: [`{{secret:${k1}}}`, "plain", { deep: `{{secret:${k2}}}` }],
      },
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.changed).toBe(true);
    expect(out.params).toEqual({
      a: "VAL_ONE",
      nested: {
        b: "prefix-VAL_TWO-suffix",
        arr: ["VAL_ONE", "plain", { deep: "VAL_TWO" }],
      },
    });
  });

  it("resolves the SAME key used twice exactly once (value cached, not double-consumed)", () => {
    // Default lifetime is use-once: if the resolver double-consumed, the second
    // placeholder would resolve to undefined and the call would block.
    const store = new SecretStore(cfg({ defaultLifetime: "use-once" }));
    const key = makeFilled(store, "ONLY_ONCE", "dup", "use-once");
    const out = resolveParams(store, {
      first: `{{secret:${key}}}`,
      second: `x-{{secret:${key}}}-y`,
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.changed).toBe(true);
    expect(out.params).toEqual({ first: "ONLY_ONCE", second: "x-ONLY_ONCE-y" });
    // Consumed exactly once -> now gone.
    expect(store.getStatus(key)).toBeUndefined();
  });

  it("returns changed:false and untouched params when there is no placeholder", () => {
    const store = new SecretStore(cfg());
    const input = { plain: "hello", n: 5, nested: { x: true } };
    const out = resolveParams(store, input);
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.changed).toBe(false);
    expect(out.params).toBe(input); // same reference, did nothing
  });

  it("leaves non-string params (number/boolean/null/nested) intact while swapping strings", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "REAL");
    const input = {
      tok: `{{secret:${key}}}`,
      count: 42,
      flag: false,
      nothing: null,
      list: [1, true, null, `{{secret:${key}}}`],
    };
    const out = resolveParams(store, input);
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.params).toEqual({
      tok: "REAL",
      count: 42,
      flag: false,
      nothing: null,
      list: [1, true, null, "REAL"],
    });
  });

  it("does NOT mutate the input object (original still has the placeholder)", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "SECRETV");
    const input: Record<string, unknown> = {
      tok: `{{secret:${key}}}`,
      nested: { inner: `{{secret:${key}}}` },
    };
    const out = resolveParams(store, input);
    if (out.kind !== "ok") throw new Error("expected ok");
    // Returned structure is a clone with substitutions.
    expect(out.params).not.toBe(input);
    expect((out.params as any).nested).not.toBe(input.nested);
    // Input untouched.
    expect(input.tok).toBe(`{{secret:${key}}}`);
    expect((input.nested as any).inner).toBe(`{{secret:${key}}}`);
  });

  it("blocks (naming the key) when a referenced key is pending", () => {
    const store = new SecretStore(cfg());
    const pendingKey = makePending(store, "Not Yet");
    const out = resolveParams(store, { tok: `{{secret:${pendingKey}}}` });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") throw new Error("expected block");
    expect(out.reason).toContain(pendingKey);
    expect(out.reason).toContain("hasn't been provided yet");
  });

  it("blocks (naming the key) when a referenced key is unknown", () => {
    const store = new SecretStore(cfg());
    const out = resolveParams(store, { tok: "{{secret:does-not-exist}}" });
    if (out.kind !== "block") throw new Error("expected block");
    expect(out.reason).toContain("does-not-exist");
    expect(out.reason).toContain("unavailable");
  });

  it("check-all-before-consume: a pending key blocks WITHOUT consuming a sibling filled use-once secret", () => {
    const store = new SecretStore(cfg());
    const filledKey = makeFilled(store, "STILL_HERE", "Filled", "use-once");
    const pendingKey = makePending(store, "Missing");
    const out = resolveParams(store, {
      good: `{{secret:${filledKey}}}`,
      bad: `{{secret:${pendingKey}}}`,
    });
    expect(out.kind).toBe("block");
    // The filled use-once secret must NOT have been consumed during the failed call.
    expect(store.getStatus(filledKey)).toBe("filled");
    // Prove it is still resolvable afterwards.
    expect(store.resolveValue(filledKey)).toBe("STILL_HERE");
  });

  it("use-once: a second resolving call referencing the same key blocks (wiped after first)", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "ONE_SHOT", "OneShot", "use-once");
    const first = resolveParams(store, { tok: `{{secret:${key}}}` });
    if (first.kind !== "ok") throw new Error("expected ok");
    expect(first.params).toEqual({ tok: "ONE_SHOT" });
    // Second call: the secret was wiped at resolve time.
    const second = resolveParams(store, { tok: `{{secret:${key}}}` });
    if (second.kind !== "block") throw new Error("expected block");
    expect(second.reason).toContain(key);
    expect(second.reason).toContain("unavailable");
  });
});

describe("createBeforeToolCall", () => {
  it("returns { params } when a placeholder was swapped", () => {
    const store = new SecretStore(cfg());
    const key = makeFilled(store, "sk-live");
    const handler = createBeforeToolCall(store);
    const res = handler({ toolName: "http", params: { apiKey: `{{secret:${key}}}` } });
    expect(res).toEqual({ params: { apiKey: "sk-live" } });
  });

  it("returns undefined when there is no placeholder (params left as-is)", () => {
    const store = new SecretStore(cfg());
    const handler = createBeforeToolCall(store);
    const res = handler({ toolName: "http", params: { plain: "v", n: 1 } });
    expect(res).toBeUndefined();
  });

  it("returns { block:true, blockReason } when a referenced secret is not ready", () => {
    const store = new SecretStore(cfg());
    const pendingKey = makePending(store, "Later");
    const handler = createBeforeToolCall(store);
    const res = handler({ toolName: "http", params: { tok: `{{secret:${pendingKey}}}` } });
    expect(res).toBeTruthy();
    if (!res) throw new Error("expected a result");
    expect(res.block).toBe(true);
    expect(res.blockReason).toContain(pendingKey);
    expect(res.params).toBeUndefined();
  });
});

describe("createAfterToolCall", () => {
  it("is a no-op returning void", () => {
    const store = new SecretStore(cfg());
    const handler = createAfterToolCall(store);
    const res = handler({ toolName: "http", params: {} });
    expect(res).toBeUndefined();
  });
});
