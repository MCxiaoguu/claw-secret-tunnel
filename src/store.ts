import { randomBytes } from "node:crypto";
import type {
  Lifetime,
  SecretRecord,
  SecretStatus,
  VanisherConfig,
} from "./types.js";

/**
 * In-memory, ephemeral secret store.
 *
 * Security posture:
 * - The plugin holds secret VALUES only in process memory; nothing is written
 *   to disk or to logs, and the value is NEVER logged or returned by any
 *   debug/inspection path other than the explicit `resolveValue` /
 *   `activeValues` accessors (and the test-only `__debugBuffer`).
 * - Values are stored as a {@link Buffer} so {@link SecretStore.wipe} can zero
 *   them in place (`buf.fill(0)`). NOTE: any JS string produced at resolve time
 *   (`buf.toString("utf8")`) lives on the V8 heap and cannot be explicitly
 *   zeroed — it lingers until GC. Buffer storage minimizes that lingering copy
 *   (we keep exactly one authoritative copy that we can scrub).
 *
 * Lifetimes (see spec §8):
 * - `use-once`: wiped immediately after the first successful {@link resolveValue}.
 * - `ttl`: wiped `ttlSeconds` after `fill`, regardless of use (timer-driven).
 * - `session`: wiped by {@link endSession}; also idle-wiped if unused for
 *   `ttlSeconds` (the idle timer is reset on each successful resolve).
 *
 * Indexing: two maps, `byToken` (token → record) and `keyToToken`
 * (key → token), so the intake handler can look up by URL token while the
 * resolver/redactor look up by agent-facing key.
 */

/**
 * Internal record. Extends the public {@link SecretRecord} shape with the
 * Buffer-backed value and timer handles, neither of which should ever escape
 * the store.
 */
interface StoredRecord extends SecretRecord {
  /** Authoritative, scrubbable copy of the secret value (set on fill). */
  valueBuf?: Buffer;
  /** ttl: value-expiry timer; session: idle-expiry timer. */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics -> '-' (collapses runs)
    .replace(/^-+|-+$/g, ""); // trim leading/trailing separators
}

/** Compact ISO-8601 basic-format timestamp at second precision, e.g. 20260604T0312Z. */
function compactIso(now: number): string {
  // 2026-06-04T03:12:00.000Z -> 20260604T0312Z
  const iso = new Date(now).toISOString();
  const [date, time] = iso.split("T");
  const ymd = date.replace(/-/g, "");
  const [hh, mm] = time.split(":");
  return `${ymd}T${hh}${mm}Z`;
}

function rand6(): string {
  return randomBytes(3).toString("hex"); // 3 bytes -> 6 hex chars
}

function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export class SecretStore {
  private readonly config: VanisherConfig;
  private readonly byToken = new Map<string, StoredRecord>();
  private readonly keyToToken = new Map<string, string>();

  constructor(config: VanisherConfig) {
    this.config = config;
  }

  /**
   * Mint a pending record. Returns the agent-facing `key` (safe to expose) and
   * the URL `token` (the capability). The value is NOT collected here.
   */
  create(label: string, lifetime?: Lifetime): { key: string; token: string } {
    const now = Date.now();
    const life = lifetime ?? this.config.defaultLifetime;
    // Defend against the (astronomically unlikely) key/token collision.
    let key = `${slug(label)}-${compactIso(now)}-${rand6()}`;
    while (this.keyToToken.has(key)) {
      key = `${slug(label)}-${compactIso(now)}-${rand6()}`;
    }
    let token = mintToken();
    while (this.byToken.has(token)) {
      token = mintToken();
    }

    const record: StoredRecord = {
      id: token,
      key,
      token,
      label,
      status: "pending",
      lifetime: life,
      createdAt: now,
      linkExpiresAt: now + this.config.linkExpirySeconds * 1000,
    };
    this.byToken.set(token, record);
    this.keyToToken.set(key, token);
    return { key, token };
  }

  /**
   * Accept a human-submitted value via the one-time link. Succeeds only when the
   * record exists, is still `pending`, and the link has not expired
   * (`now <= linkExpiresAt`). Rejects unknown tokens, expired links, and any
   * second submission. The value is stored as a Buffer; for `ttl` lifetime the
   * value-expiry timer is armed here.
   */
  fill(token: string, value: string): boolean {
    const record = this.byToken.get(token);
    if (!record) return false;
    if (record.status !== "pending") return false;
    const now = Date.now();
    if (now > record.linkExpiresAt) return false;

    record.valueBuf = Buffer.from(value, "utf8");
    record.status = "filled";
    record.filledAt = now;

    if (record.lifetime === "ttl") {
      record.valueExpiresAt = now + this.config.ttlSeconds * 1000;
      this.armTimer(record, this.config.ttlSeconds * 1000);
    }
    return true;
  }

  /**
   * Resolve the real value at point-of-use. Returns `undefined` unless the
   * record is `filled` and not value-expired. On success, updates `lastUsedAt`;
   * for `session` lifetime resets the idle timer; for `use-once` wipes the
   * record immediately after capturing the return value (so a second resolve
   * yields `undefined`).
   */
  resolveValue(key: string): string | undefined {
    const record = this.getRecord(key);
    if (!record || record.status !== "filled" || !record.valueBuf) {
      return undefined;
    }
    const now = Date.now();
    if (record.valueExpiresAt !== undefined && now > record.valueExpiresAt) {
      // Lazily wipe an expired value if a timer hasn't fired yet.
      this.wipe(record);
      return undefined;
    }

    const value = record.valueBuf.toString("utf8");
    record.lastUsedAt = now;

    if (record.lifetime === "use-once") {
      this.wipe(record);
    } else if (record.lifetime === "session") {
      // Reset idle timeout on each use.
      this.armTimer(record, this.config.ttlSeconds * 1000);
    }
    return value;
  }

  /**
   * Status for the resolver to choose a block reason without leaking the value.
   * `undefined` means the key is unknown (or already wiped).
   */
  getStatus(key: string): SecretStatus | undefined {
    return this.getRecord(key)?.status;
  }

  /** Live secret values currently held (filled, not wiped). For the redaction backstop. */
  activeValues(): string[] {
    const values: string[] = [];
    for (const record of this.byToken.values()) {
      if (record.status === "filled" && record.valueBuf) {
        values.push(record.valueBuf.toString("utf8"));
      }
    }
    return values;
  }

  /** Wipe all `session`-lifetime records (called on `session_end`). */
  endSession(): void {
    for (const record of [...this.byToken.values()]) {
      if (record.lifetime === "session") {
        this.wipe(record);
      }
    }
  }

  /** Wipe everything (called on `gateway_stop`). */
  clearAll(): void {
    for (const record of [...this.byToken.values()]) {
      this.wipe(record);
    }
  }

  /**
   * Test-only accessor to assert buffer zeroing on wipe. NOT part of the public
   * runtime contract — do not use outside tests. Returns the internal Buffer
   * reference (which, post-wipe, will be all zeros) or `undefined`.
   */
  __debugBuffer(key: string): Buffer | undefined {
    return this.getRecord(key)?.valueBuf;
  }

  private getRecord(key: string): StoredRecord | undefined {
    const token = this.keyToToken.get(key);
    if (token === undefined) return undefined;
    return this.byToken.get(token);
  }

  /** (Re)arm the single per-record expiry/idle timer; never keeps the process alive. */
  private armTimer(record: StoredRecord, ms: number): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    const timer = setTimeout(() => this.wipe(record), ms);
    timer.unref();
    record.expiryTimer = timer;
  }

  /**
   * Best-effort secure wipe: zero the value buffer in place, clear the timer,
   * and remove the record from both maps. After this the value is no longer
   * retrievable and the key reads as unknown.
   */
  private wipe(record: StoredRecord): void {
    if (record.expiryTimer) {
      clearTimeout(record.expiryTimer);
      record.expiryTimer = undefined;
    }
    if (record.valueBuf) {
      record.valueBuf.fill(0);
    }
    record.status = "consumed";
    this.byToken.delete(record.token);
    this.keyToToken.delete(record.key);
  }
}
