import { describe, it, expect } from "vitest";
import { SecretStore } from "../src/store.js";
import { DEFAULT_CONFIG, type Lifetime, type VanisherConfig } from "../src/types.js";
import {
  redactString,
  createMessageSending,
  createToolResultPersist,
} from "../src/redact.js";

function cfg(overrides: Partial<VanisherConfig> = {}): VanisherConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Create + fill a secret so the store reports it as a live value via
 * `activeValues()`. Returns the agent-facing key (rarely needed for redaction
 * tests, which scan by value). Uses `session` lifetime by default so the value
 * stays live across multiple reads (use-once would self-wipe on first resolve,
 * but the redactor reads via `activeValues()` which does not consume).
 */
function fillSecret(
  store: SecretStore,
  value: string,
  label = "API Key",
  lifetime: Lifetime = "session",
): string {
  const { key, token } = store.create(label, lifetime);
  const ok = store.fill(token, value);
  expect(ok).toBe(true);
  return key;
}

describe("redactString", () => {
  it("replaces a single live value and leaves surrounding text intact", () => {
    const value = "sk-live-abcdef1234";
    const out = redactString([value], `before ${value} after`);
    expect(out).toBe("before [redacted-secret] after");
  });

  it("replaces every occurrence of a value (not just the first)", () => {
    const value = "supersecretvalue";
    const out = redactString([value], `${value} and again ${value}`);
    expect(out).toBe("[redacted-secret] and again [redacted-secret]");
  });

  it("handles multiple distinct values in one string", () => {
    const a = "first-secret-aaaa";
    const b = "second-secret-bbbb";
    const out = redactString([a, b], `x ${a} y ${b} z`);
    expect(out).toBe("x [redacted-secret] y [redacted-secret] z");
  });

  it("redacts the longest match first when one value is a substring of another", () => {
    // "abcdef123456" contains "abcdef" — but only the SHORTER one is < 6? no,
    // both are >= 6. Longest-first means the full token is collapsed to one
    // marker, not the prefix leaving a dangling suffix.
    const short = "abcdef12"; // 8 chars, substring of long
    const long = "abcdef123456"; // 12 chars, contains `short`
    const out = redactString([short, long], `tok=${long}`);
    // If we matched `short` first we'd get "[redacted-secret]3456"; longest-first
    // collapses the whole token.
    expect(out).toBe("tok=[redacted-secret]");
  });

  it("matches values containing regex special characters literally", () => {
    const value = "a.b*c+d(e)[f]^g$"; // full of regex metacharacters
    const out = redactString([value], `x ${value} y`);
    expect(out).toBe("x [redacted-secret] y");
  });

  it("does not redact a regex special value as a pattern (e.g. a.b matches literally, not 'axb')", () => {
    const value = "a.b.c.d"; // would match "aXbYcZd" if treated as regex
    const haystack = "aXbYcZd should stay, a.b.c.d should go";
    const out = redactString([value], haystack);
    expect(out).toBe("aXbYcZd should stay, [redacted-secret] should go");
  });

  it("does NOT redact values shorter than MIN_REDACT_LEN (6 chars)", () => {
    const out = redactString(["abc", "12345"], "abc and 12345 stay put");
    expect(out).toBe("abc and 12345 stay put");
  });

  it("redacts a 6-char value (boundary) but not a 5-char one", () => {
    const out6 = redactString(["abcde6"], "value abcde6 here");
    expect(out6).toBe("value [redacted-secret] here");
    const out5 = redactString(["abcd5"], "value abcd5 here");
    expect(out5).toBe("value abcd5 here");
  });

  it("returns the string unchanged for an empty values list", () => {
    const s = "nothing to redact here";
    expect(redactString([], s)).toBe(s);
  });

  it("returns the string unchanged when all values are below the threshold", () => {
    const s = "abc def 12345";
    expect(redactString(["abc", "def", "12345"], s)).toBe(s);
  });

  it("dedups repeated values without error", () => {
    const value = "repeated-secret-xyz";
    const out = redactString([value, value, value], `q ${value} q`);
    expect(out).toBe("q [redacted-secret] q");
  });

  it("never leaks the raw value into the output", () => {
    const value = "topsecret-value-zzz";
    const out = redactString([value], `leak? ${value}`);
    expect(out).not.toContain(value);
    expect(out).toContain("[redacted-secret]");
  });
});

describe("createMessageSending", () => {
  it("redacts a live value in outbound content and returns { content }", () => {
    const store = new SecretStore(cfg());
    const value = "sk-outbound-9988";
    fillSecret(store, value);
    const handler = createMessageSending(store);
    const res = handler({ to: "user", content: `oops the key is ${value}` });
    expect(res).toEqual({ content: "oops the key is [redacted-secret]" });
  });

  it("returns undefined when the content has no live value (no change, no cancel)", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "sk-held-but-not-echoed-1234");
    const handler = createMessageSending(store);
    const res = handler({ to: "user", content: "a perfectly clean message" });
    expect(res).toBeUndefined();
  });

  it("never cancels — only rewrites content", () => {
    const store = new SecretStore(cfg());
    const value = "cancel-not-allowed-secret";
    fillSecret(store, value);
    const handler = createMessageSending(store);
    const res = handler({ to: "user", content: `here: ${value}` });
    expect(res).toBeTruthy();
    if (!res) throw new Error("expected a result");
    expect((res as { cancel?: boolean }).cancel).toBeUndefined();
    expect(res.content).toBe("here: [redacted-secret]");
  });

  it("returns undefined when there are no live values at all", () => {
    const store = new SecretStore(cfg());
    const handler = createMessageSending(store);
    const res = handler({ to: "user", content: "anything goes" });
    expect(res).toBeUndefined();
  });

  it("leaves a below-threshold value intact in outbound content (proves the threshold)", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "abcd"); // 4 chars, below MIN_REDACT_LEN
    const handler = createMessageSending(store);
    const res = handler({ to: "user", content: "the word abcd is common" });
    expect(res).toBeUndefined();
  });
});

describe("createToolResultPersist", () => {
  it("redacts a string message.content containing a live value and returns { message }", () => {
    const store = new SecretStore(cfg());
    const value = "tool-result-secret-7777";
    fillSecret(store, value);
    const handler = createToolResultPersist(store);
    const res = handler({
      toolName: "http",
      message: { content: `response body had ${value}`, role: "tool" },
    });
    expect(res).toEqual({
      message: { content: "response body had [redacted-secret]", role: "tool" },
    });
  });

  it("preserves other message fields while redacting content", () => {
    const store = new SecretStore(cfg());
    const value = "preserve-fields-secret-1";
    fillSecret(store, value);
    const handler = createToolResultPersist(store);
    const res = handler({
      message: { content: `x ${value}`, role: "tool", extra: 42 },
    });
    if (!res) throw new Error("expected a result");
    expect(res.message).toEqual({
      content: "x [redacted-secret]",
      role: "tool",
      extra: 42,
    });
  });

  it("redacts each text part in an array-of-parts content", () => {
    const store = new SecretStore(cfg());
    const value = "array-part-secret-5555";
    fillSecret(store, value);
    const handler = createToolResultPersist(store);
    const res = handler({
      message: {
        content: [
          { type: "text", text: `first ${value}` },
          { type: "text", text: "clean part" },
          { type: "text", text: `again ${value} again` },
        ],
      } as unknown as { content?: string; [k: string]: unknown },
    });
    if (!res) throw new Error("expected a result");
    expect(res.message?.content).toEqual([
      { type: "text", text: "first [redacted-secret]" },
      { type: "text", text: "clean part" },
      { type: "text", text: "again [redacted-secret] again" },
    ]);
  });

  it("returns undefined when string content has no live value", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "held-secret-not-in-output");
    const handler = createToolResultPersist(store);
    const res = handler({ message: { content: "totally clean tool output" } });
    expect(res).toBeUndefined();
  });

  it("returns undefined when there is no content at all", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "some-live-secret-value");
    const handler = createToolResultPersist(store);
    const res = handler({ message: { role: "tool" } });
    expect(res).toBeUndefined();
  });

  it("leaves non-text/odd content shapes as-is (returns undefined)", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "another-live-secret-val");
    const handler = createToolResultPersist(store);
    // content is a number — neither string nor array-of-text-parts.
    const res = handler({
      message: { content: 12345 as unknown as string },
    });
    expect(res).toBeUndefined();
  });

  it("leaves array parts that are not text-parts untouched", () => {
    const store = new SecretStore(cfg());
    const value = "mixed-array-secret-9090";
    fillSecret(store, value);
    const handler = createToolResultPersist(store);
    const res = handler({
      message: {
        content: [
          { type: "image", url: "http://x" },
          { type: "text", text: `leak ${value}` },
        ],
      } as unknown as { content?: string; [k: string]: unknown },
    });
    if (!res) throw new Error("expected a result");
    expect(res.message?.content).toEqual([
      { type: "image", url: "http://x" },
      { type: "text", text: "leak [redacted-secret]" },
    ]);
  });

  it("leaves a below-threshold value intact in tool-result content (proves the threshold)", () => {
    const store = new SecretStore(cfg());
    fillSecret(store, "key1"); // 4 chars
    const handler = createToolResultPersist(store);
    const res = handler({ message: { content: "the key1 token is short" } });
    expect(res).toBeUndefined();
  });
});
