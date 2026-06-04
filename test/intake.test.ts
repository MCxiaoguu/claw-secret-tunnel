import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createIntakeHandler } from "../src/intake.js";
import { SecretStore } from "../src/store.js";
import { DEFAULT_CONFIG, type SecretTunnelConfig } from "../src/types.js";

function cfg(overrides: Partial<SecretTunnelConfig> = {}): SecretTunnelConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const ROUTE = DEFAULT_CONFIG.routePath;

/**
 * Stand up a real loopback HTTP server wrapping the intake handler so the
 * body-reading / streaming path is exercised the same way the gateway drives
 * it. Returns the base origin and a disposer.
 */
async function serve(store: SecretStore, routePath = ROUTE) {
  const handler = createIntakeHandler(store, routePath);
  const server: Server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

describe("createIntakeHandler", () => {
  let logSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    // Spy (and silence) every console channel so we can assert the secret value
    // is never written to any of them.
    logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function assertNeverLogged(value: string) {
    for (const spy of logSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(value);
        }
      }
    }
  }

  describe("GET", () => {
    it("serves a 200 HTML form with the label for a pending token; no secret echoed", async () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("OpenAI API Key");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/html/i);
        expect(res.headers.get("content-type")).toMatch(/charset=utf-8/i);
        const html = await res.text();
        expect(html).toMatch(/<form[^>]*method=["']?post["']?/i);
        expect(html).toMatch(/name=["']secret["']/i);
        expect(html).toMatch(/type=["']password["']/i);
        expect(html.toLowerCase()).toContain("autofocus");
        // The label is shown.
        expect(html).toContain("OpenAI API Key");
        // The token (capability) must NOT be present anywhere it could leak.
        // (It is fine for the form to POST to the same relative URL, so we only
        // assert there is no value — there is none yet — and the page renders.)
      } finally {
        await srv.close();
      }
    });

    it("HTML-escapes the label to prevent XSS", async () => {
      const store = new SecretStore(cfg());
      const { token } = store.create('<script>alert("x")</script>');
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`);
        const html = await res.text();
        expect(html).not.toContain("<script>alert");
        expect(html).toContain("&lt;script&gt;");
      } finally {
        await srv.close();
      }
    });

    it("returns 404 for an unknown token", async () => {
      const store = new SecretStore(cfg());
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/totally-unknown-token`);
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toMatch(/text\/html/i);
        const html = await res.text();
        expect(html).not.toMatch(/<form/i);
      } finally {
        await srv.close();
      }
    });

    it("returns 410 when the link has expired", async () => {
      const store = new SecretStore(cfg({ linkExpirySeconds: 1 }));
      const { token } = store.create("api");
      // Move wall-clock forward past the link expiry (no fake timers: the store
      // compares Date.now() to linkExpiresAt). 1s expiry -> wait > 1s.
      const srv = await serve(store);
      try {
        await new Promise((r) => setTimeout(r, 1100));
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`);
        expect(res.status).toBe(410);
        const html = await res.text();
        expect(html).not.toMatch(/<form/i);
      } finally {
        await srv.close();
      }
    });

    it("returns 410 'already used' once the record is filled/consumed", async () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("api");
      store.fill(token, "already-here");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`);
        expect(res.status).toBe(410);
        const html = await res.text();
        expect(html).not.toMatch(/<form/i);
        expect(html).not.toContain("already-here");
        assertNeverLogged("already-here");
      } finally {
        await srv.close();
      }
    });

    it("accepts the token via ?token= query fallback", async () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("Query Token Key");
      const srv = await serve(store);
      try {
        const res = await fetch(
          `${srv.origin}${ROUTE}?token=${encodeURIComponent(token)}`,
        );
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Query Token Key");
      } finally {
        await srv.close();
      }
    });

    it("accepts the token via ?t= query fallback", async () => {
      const store = new SecretStore(cfg());
      const { token } = store.create("Short Query Key");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}?t=${encodeURIComponent(token)}`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Short Query Key");
      } finally {
        await srv.close();
      }
    });
  });

  describe("POST", () => {
    it("captures a urlencoded secret and flips the record to filled", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "sk-live-12345" }).toString(),
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html.toLowerCase()).toContain("close");
        // The value is now held; peek via session lifetime-independent resolve.
        expect(store.resolveValue(key)).toBe("sk-live-12345");
        // Never echoed in the success page, never logged.
        expect(html).not.toContain("sk-live-12345");
        assertNeverLogged("sk-live-12345");
      } finally {
        await srv.close();
      }
    });

    it("captures a JSON secret body", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: "json-secret-value" }),
        });
        expect(res.status).toBe(200);
        expect(store.resolveValue(key)).toBe("json-secret-value");
        assertNeverLogged("json-secret-value");
      } finally {
        await srv.close();
      }
    });

    it("captures the secret when the token comes via ?token= fallback", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "via-query-secret" }).toString(),
        });
        expect(res.status).toBe(200);
        expect(store.resolveValue(key)).toBe("via-query-secret");
      } finally {
        await srv.close();
      }
    });

    it("rejects a second submission with 4xx and does not overwrite the value", async () => {
      const store = new SecretStore(cfg({ defaultLifetime: "session" }));
      const { key, token } = store.create("api", "session");
      const srv = await serve(store);
      try {
        const first = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "first-value" }).toString(),
        });
        expect(first.status).toBe(200);

        const second = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "second-value" }).toString(),
        });
        expect(second.status).toBeGreaterThanOrEqual(400);
        expect(second.status).toBeLessThan(500);
        // Value unchanged by the rejected second submission.
        expect(store.resolveValue(key)).toBe("first-value");
        assertNeverLogged("first-value");
        assertNeverLogged("second-value");
      } finally {
        await srv.close();
      }
    });

    it("rejects a POST with no secret field (4xx) and leaves the record pending", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ notsecret: "x" }).toString(),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(store.getStatus(key)).toBe("pending");
      } finally {
        await srv.close();
      }
    });

    it("rejects an empty secret value (4xx)", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "" }).toString(),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(store.getStatus(key)).toBe("pending");
      } finally {
        await srv.close();
      }
    });

    it("rejects an over-size body with 413 and does not fill the record", async () => {
      const store = new SecretStore(cfg());
      const { key, token } = store.create("api");
      const srv = await serve(store);
      try {
        const huge = "a".repeat(1024 * 1024 + 64 * 1024); // ~1.06 MB > 1 MB cap
        const res = await fetch(`${srv.origin}${ROUTE}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: huge }).toString(),
        });
        expect(res.status).toBe(413);
        expect(store.getStatus(key)).toBe("pending");
        expect(store.resolveValue(key)).toBeUndefined();
      } finally {
        await srv.close();
      }
    });

    it("rejects a POST to an unknown token with 4xx", async () => {
      const store = new SecretStore(cfg());
      const srv = await serve(store);
      try {
        const res = await fetch(`${srv.origin}${ROUTE}/ghost-token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: "v" }).toString(),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      } finally {
        await srv.close();
      }
    });
  });
});
