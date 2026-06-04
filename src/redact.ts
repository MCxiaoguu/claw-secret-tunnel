import type { SecretStore } from "./store.js";
import type {
  MessageSendingEvent,
  MessageSendingResult,
  ToolResultPersistEvent,
  ToolResultPersistResult,
} from "./openclaw.js";

/**
 * Output redaction backstop (spec §5(e), §11).
 *
 * Defense-in-depth, NOT the primary guarantee. The real protection is that a
 * secret value never reaches the model at all: the agent only ever sees the
 * `{{secret:<key>}}` placeholder, and the value is swapped in at the tool
 * boundary (see `resolver.ts`). This module exists only to catch *accidental
 * echoes* — a tool result or outbound message that somehow contains a live
 * value — and scrub it before it is persisted or sent.
 *
 * Security posture:
 * - This module reads live secret values (via `store.activeValues()`) ONLY to
 *   scan output for them. It MUST NEVER log them (no console/logger calls here)
 *   and MUST NOT store or return a raw value: the only thing it ever emits in
 *   place of a matched value is the literal {@link REDACTION_MARKER}.
 *
 * Over-redaction trade-off (`MIN_REDACT_LEN`):
 * - Values shorter than {@link MIN_REDACT_LEN} are deliberately NOT redacted.
 *   A short secret (e.g. a 4-digit PIN, the string "true", a common word) would
 *   match legitimate output everywhere and mangle it. Because the primary
 *   guarantee already keeps the value away from the model, accepting the small
 *   residual risk of an un-scrubbed *short* accidental echo is the better
 *   trade-off than corrupting every message that happens to contain a common
 *   short substring. Longer values (the overwhelming majority of API keys,
 *   tokens, passwords) are fully covered.
 */

/** Replacement text substituted for any matched live secret value. */
export const REDACTION_MARKER = "[redacted-secret]";

/**
 * Minimum length a live value must have to be eligible for redaction. Values
 * shorter than this are skipped — see the over-redaction trade-off above. This
 * backstop only catches accidental echoes; it must not corrupt legitimate
 * output by collapsing common short strings.
 */
export const MIN_REDACT_LEN = 6;

/** Escape regex metacharacters so an arbitrary value matches literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence of each live `value` in `s` with
 * {@link REDACTION_MARKER}.
 *
 * - Values are arbitrary strings, so each is regex-escaped before matching.
 * - Values are sorted longest-first and de-duplicated, so when one value is a
 *   substring of another the longest match wins (no dangling suffix left over).
 * - Values shorter than {@link MIN_REDACT_LEN} are skipped (see trade-off note).
 * - Empty `values` (or all below threshold) returns `s` unchanged.
 */
export function redactString(values: string[], s: string): string {
  // Dedup + drop below-threshold values, then sort longest-first so overlapping
  // / substring values collapse to a single marker (longest match first).
  const eligible = [...new Set(values)]
    .filter((v) => v.length >= MIN_REDACT_LEN)
    .sort((a, b) => b.length - a.length);

  if (eligible.length === 0) return s;

  let result = s;
  for (const value of eligible) {
    const pattern = new RegExp(escapeRegExp(value), "g");
    result = result.replace(pattern, REDACTION_MARKER);
  }
  return result;
}

/** True for a `{ type: "text", text: string }` content part. */
function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

/**
 * `message_sending` hook: scrub any live secret value from outbound content.
 *
 * Returns `{ content }` only when redaction changed the text; otherwise
 * `undefined` (no change). Never cancels the message — this backstop rewrites,
 * it does not block delivery.
 */
export function createMessageSending(
  store: SecretStore,
): (event: MessageSendingEvent) => MessageSendingResult {
  return (event: MessageSendingEvent): MessageSendingResult => {
    const values = store.activeValues();
    const redacted = redactString(values, event.content);
    if (redacted === event.content) return undefined;
    return { content: redacted };
  };
}

/**
 * `tool_result_persist` hook: scrub any live secret value from a tool-result
 * message before it is persisted.
 *
 * Defensive about `message.content` shape:
 * - string                       → redact it.
 * - array of `{type:"text",text}` → redact each part's `text` (non-text parts
 *   are left untouched).
 * - anything else                → left as-is.
 *
 * Returns `{ message: { ...event.message, content: <redacted> } }` only when
 * something changed; otherwise `undefined`.
 */
export function createToolResultPersist(
  store: SecretStore,
): (event: ToolResultPersistEvent) => ToolResultPersistResult {
  return (event: ToolResultPersistEvent): ToolResultPersistResult => {
    const values = store.activeValues();
    const content: unknown = event.message.content;

    if (typeof content === "string") {
      const redacted = redactString(values, content);
      if (redacted === content) return undefined;
      return { message: { ...event.message, content: redacted } };
    }

    if (Array.isArray(content)) {
      let changed = false;
      const next = content.map((part) => {
        if (!isTextPart(part)) return part;
        const redacted = redactString(values, part.text);
        if (redacted === part.text) return part;
        changed = true;
        return { ...part, text: redacted };
      });
      if (!changed) return undefined;
      // `content` is typed `string | undefined` on the message; the runtime
      // shape is broader (parts array), so we cast at this boundary only.
      return {
        message: {
          ...event.message,
          content: next as unknown as string,
        },
      };
    }

    // Unknown shape (number, object, null, undefined) — leave as-is.
    return undefined;
  };
}
