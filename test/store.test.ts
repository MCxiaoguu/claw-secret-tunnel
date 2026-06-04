import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretStore } from "../src/store.js";
import { DEFAULT_CONFIG, type SecretTunnelConfig } from "../src/types.js";

function cfg(overrides: Partial<SecretTunnelConfig> = {}): SecretTunnelConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("SecretStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T03:12:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("create", () => {
    it("returns a key + token and registers a pending record", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("OpenAI API Key");
      expect(typeof key).toBe("string");
      expect(typeof token).toBe("string");
      expect(key).not.toBe(token);
      expect(store.getStatus(key)).toBe("pending");
    });

    it("key embeds the slug + compact ISO timestamp + rand6 suffix", () => {
      const store = new SecretStore(cfg());
      const { key } = store.create("OpenAI API Key!!");
      // slug -> lowercase, non-alnum -> '-', collapsed
      expect(key).toMatch(/^openai-api-key-20260604T0312Z-[0-9a-f]{6}$/);
    });

    it("collapses repeated separators and trims edge separators in the slug", () => {
      const store = new SecretStore(cfg());
      const { key } = store.create("  Foo___Bar  ");
      expect(key).toMatch(/^foo-bar-20260604T0312Z-[0-9a-f]{6}$/);
    });

    it("produces unique keys + tokens across calls with the same label", () => {
      const store = new SecretStore(cfg());
      const a = store.create("dup");
      const b = store.create("dup");
      expect(a.key).not.toBe(b.key);
      expect(a.token).not.toBe(b.token);
    });

    it("token looks like base64url (no +,/,= padding)", () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("x");
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(40); // 32 bytes b64url ~= 43 chars
    });

    it("honors a lifetime override at create time", () => {
      const store = new SecretStore(cfg({ defaultLifetime: "use-once" }));
      const { key, token } = store.create("ttl-secret", "ttl");
      store.fill(token, "v");
      // ttl lifetime should arm a timer; verify by advancing past ttlSeconds
      vi.advanceTimersByTime(DEFAULT_CONFIG.ttlSeconds * 1000 + 1);
      expect(store.resolveValue(key)).toBeUndefined();
    });
  });

  describe("fill", () => {
    it("flips a pending record to filled and stores the value", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      expect(store.fill(token, "sk-secret-value")).toBe(true);
      expect(store.getStatus(key)).toBe("filled");
      expect(store.resolveValue(key)).toBe("sk-secret-value");
    });

    it("rejects an unknown token", () => {
      const store = new SecretStore(cfg());
      expect(store.fill("not-a-real-token", "v")).toBe(false);
    });

    it("rejects a submission after the link has expired", () => {
      const store = new SecretStore(cfg({ linkExpirySeconds: 600 }));
      const { key, token } = store.create("api");
      vi.advanceTimersByTime(600 * 1000 + 1);
      expect(store.fill(token, "v")).toBe(false);
      expect(store.getStatus(key)).toBe("pending");
      expect(store.resolveValue(key)).toBeUndefined();
    });

    it("accepts a submission exactly at the link expiry boundary", () => {
      const store = new SecretStore(cfg({ linkExpirySeconds: 600 }));
      const { token } = store.create("api");
      vi.advanceTimersByTime(600 * 1000); // now === linkExpiresAt
      expect(store.fill(token, "v")).toBe(true);
    });

    it("rejects a second submission for the same token", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      expect(store.fill(token, "first")).toBe(true);
      expect(store.fill(token, "second")).toBe(false);
      expect(store.resolveValue(key)).toBe("first");
    });

    it("sets valueExpiresAt for ttl lifetime on fill", () => {
      const store = new SecretStore(cfg({ ttlSeconds: 300 }));
      const { key, token } = store.create("api", "ttl");
      store.fill(token, "v");
      // still valid just before ttl
      vi.advanceTimersByTime(300 * 1000 - 1);
      expect(store.resolveValue(key)).toBe("v");
    });
  });

  describe("resolveValue", () => {
    it("returns undefined for a pending record", () => {
      const store = new SecretStore(cfg());
      const { key } = store.create("api");
      expect(store.resolveValue(key)).toBeUndefined();
    });

    it("returns undefined for an unknown key", () => {
      const store = new SecretStore(cfg());
      expect(store.resolveValue("ghost-key")).toBeUndefined();
    });

    it("returns the value for a filled record (non use-once keeps it across resolves)", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "session");
      store.fill(token, "hold-me");
      expect(store.resolveValue(key)).toBe("hold-me");
      expect(store.resolveValue(key)).toBe("hold-me");
    });
  });

  describe("tokenInfo", () => {
    it("returns the label + pending status for a fresh pending record", () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("OpenAI API Key");
      expect(store.tokenInfo(token)).toEqual({
        label: "OpenAI API Key",
        status: "pending",
      });
    });

    it("reports a pending record with an expired link as expired (without mutating it)", () => {
      const store = new SecretStore(cfg({ linkExpirySeconds: 600 }));
      const { key, token } = store.create("api");
      vi.advanceTimersByTime(600 * 1000 + 1);
      expect(store.tokenInfo(token)).toEqual({ label: "api", status: "expired" });
      // read-only: the record must still be 'pending' (not mutated to expired/consumed),
      // so the underlying status is unchanged and a fresh fill (had the link not
      // expired) would still be governed by fill()'s own expiry check.
      expect(store.getStatus(key)).toBe("pending");
    });

    it("treats the exact link-expiry boundary as still pending", () => {
      const store = new SecretStore(cfg({ linkExpirySeconds: 600 }));
      const { token } = store.create("api");
      vi.advanceTimersByTime(600 * 1000); // now === linkExpiresAt (not > )
      expect(store.tokenInfo(token)).toEqual({ label: "api", status: "pending" });
    });

    it("returns the filled status once the record is filled", () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("api");
      store.fill(token, "sk-secret");
      expect(store.tokenInfo(token)).toEqual({ label: "api", status: "filled" });
    });

    it("returns undefined for an unknown token", () => {
      const store = new SecretStore(cfg());
      expect(store.tokenInfo("not-a-real-token")).toBeUndefined();
    });

    it("returns undefined once a use-once record has been consumed/wiped", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "use-once");
      store.fill(token, "one-shot");
      store.resolveValue(key); // wipes the record
      expect(store.tokenInfo(token)).toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("returns undefined for an unknown key", () => {
      const store = new SecretStore(cfg());
      expect(store.getStatus("nope")).toBeUndefined();
    });
    it("reflects pending then filled", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "session");
      expect(store.getStatus(key)).toBe("pending");
      store.fill(token, "v");
      expect(store.getStatus(key)).toBe("filled");
    });
  });

  describe("use-once lifetime", () => {
    it("wipes after the first resolve; second resolve is undefined and key is gone", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "use-once");
      store.fill(token, "one-shot");
      expect(store.resolveValue(key)).toBe("one-shot");
      // wiped immediately after returning the value
      expect(store.resolveValue(key)).toBeUndefined();
      expect(store.getStatus(key)).toBeUndefined();
      expect(store.activeValues()).not.toContain("one-shot");
    });

    it("zeroes the stored buffer on wipe", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "use-once");
      store.fill(token, "zero-me");
      const buf = store.__debugBuffer(key)!;
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.toString("utf8")).toBe("zero-me");
      store.resolveValue(key); // triggers wipe
      // the buffer captured above should have been zeroed in place
      expect(buf.every((b) => b === 0)).toBe(true);
    });
  });

  describe("ttl lifetime", () => {
    it("wipes the value once ttlSeconds elapse after fill", () => {
      const store = new SecretStore(cfg({ ttlSeconds: 300 }));
      const { key, token } = store.create("api", "ttl");
      store.fill(token, "expiring");
      expect(store.resolveValue(key)).toBe("expiring");
      vi.advanceTimersByTime(300 * 1000 + 1);
      expect(store.resolveValue(key)).toBeUndefined();
      expect(store.getStatus(key)).toBeUndefined();
      expect(store.activeValues()).not.toContain("expiring");
    });
  });

  describe("session lifetime", () => {
    it("is wiped by endSession()", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api", "session");
      store.fill(token, "session-val");
      expect(store.resolveValue(key)).toBe("session-val");
      store.endSession();
      expect(store.getStatus(key)).toBeUndefined();
      expect(store.activeValues()).not.toContain("session-val");
    });

    it("is wiped after an idle timeout of ttlSeconds since last use", () => {
      const store = new SecretStore(cfg({ ttlSeconds: 300 }));
      const { key, token } = store.create("api", "session");
      store.fill(token, "idle-val");
      // use it, which should reset the idle timer
      vi.advanceTimersByTime(200 * 1000);
      expect(store.resolveValue(key)).toBe("idle-val");
      // not yet idle past ttl since last use
      vi.advanceTimersByTime(299 * 1000);
      expect(store.resolveValue(key)).toBe("idle-val");
      // now go idle past ttl
      vi.advanceTimersByTime(300 * 1000 + 1);
      expect(store.resolveValue(key)).toBeUndefined();
      expect(store.getStatus(key)).toBeUndefined();
    });

    it("endSession() leaves use-once and ttl records intact", () => {
      const store = new SecretStore(cfg());
      const once = store.create("once", "use-once");
      const ttl = store.create("ttl", "ttl");
      store.fill(once.token, "once-val");
      store.fill(ttl.token, "ttl-val");
      store.endSession();
      expect(store.getStatus(once.key)).toBe("filled");
      expect(store.getStatus(ttl.key)).toBe("filled");
    });
  });

  describe("activeValues", () => {
    it("lists only live (filled, not wiped) values", () => {
      const store = new SecretStore(cfg());
      const a = store.create("a", "session");
      const b = store.create("b", "session");
      store.fill(a.token, "alpha-value");
      // b stays pending -> no value
      expect(store.activeValues()).toEqual(["alpha-value"]);
      expect(store.getStatus(b.key)).toBe("pending");
    });

    it("drops values once their record is wiped", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("a", "session");
      store.fill(token, "gone-soon");
      expect(store.activeValues()).toContain("gone-soon");
      store.endSession();
      expect(store.activeValues()).not.toContain("gone-soon");
    });
  });

  describe("clearAll", () => {
    it("empties every record regardless of lifetime", () => {
      const store = new SecretStore(cfg());
      const once = store.create("once", "use-once");
      const ttl = store.create("ttl", "ttl");
      const sess = store.create("sess", "session");
      store.fill(once.token, "v1");
      store.fill(ttl.token, "v2");
      store.fill(sess.token, "v3");
      store.clearAll();
      expect(store.activeValues()).toEqual([]);
      expect(store.getStatus(once.key)).toBeUndefined();
      expect(store.getStatus(ttl.key)).toBeUndefined();
      expect(store.getStatus(sess.key)).toBeUndefined();
    });

    it("zeroes buffers on clearAll", () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("a", "session");
      store.fill(token, "wipe-on-clear");
      const buf = store.__debugBuffer(key)!;
      store.clearAll();
      expect(buf.every((b) => b === 0)).toBe(true);
    });

    it("does not leave timers that keep the process alive (timers cleared)", () => {
      const store = new SecretStore(cfg({ ttlSeconds: 300 }));
      const { key, token } = store.create("a", "ttl");
      store.fill(token, "v");
      store.clearAll();
      // advancing past the ttl must not throw / re-wipe a missing record
      expect(() => vi.advanceTimersByTime(300 * 1000 + 1)).not.toThrow();
      expect(store.getStatus(key)).toBeUndefined();
    });
  });
});
