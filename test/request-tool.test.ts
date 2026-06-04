import { describe, it, expect, vi } from "vitest";
import { Kind } from "@sinclair/typebox";
import { createRequestSecretTool } from "../src/request-tool.js";
import { SecretStore } from "../src/store.js";
import { DEFAULT_CONFIG, type Lifetime, type VanisherConfig } from "../src/types.js";

function cfg(overrides: Partial<VanisherConfig> = {}): VanisherConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const BASE = "https://host.tail1234.ts.net";
const ROUTE = "/vanish";

/** Default deps with a REAL SecretStore so behavior is exercised end-to-end. */
function makeDeps(
  overrides: Partial<Parameters<typeof createRequestSecretTool>[0]> = {},
) {
  const store = new SecretStore(cfg());
  return {
    store,
    getBaseUrl: () => ({ url: BASE }),
    routePath: ROUTE,
    defaultLifetime: "use-once" as Lifetime,
    ...overrides,
  };
}

/** Concatenate all text segments of a ToolResult. */
function textOf(result: {
  content: Array<{ type: "text"; text: string }>;
}): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Pull the token out of the link query (`?token=...`). */
function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get("token");
  if (token === null) throw new Error(`link has no token query: ${link}`);
  return token;
}

describe("createRequestSecretTool", () => {
  describe("tool shape", () => {
    it("is named request_secret with a non-empty description", () => {
      const tool = createRequestSecretTool(makeDeps());
      expect(tool.name).toBe("request_secret");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    });

    it("declares typebox parameters that are a valid TSchema object", () => {
      const tool = createRequestSecretTool(makeDeps());
      // Inspect the schema structurally via an `unknown` hop (TSchema is opaque).
      const schema = tool.parameters as unknown as {
        type?: unknown;
        properties: Record<string, unknown>;
        required?: string[];
        [k: symbol]: unknown;
      };
      // Type.Object schemas carry type === "object" and the typebox Kind symbol.
      expect(schema.type).toBe("object");
      expect(schema[Kind]).toBe("Object");
      // label is required; lifetime + purpose optional.
      const props = schema.properties;
      expect(props).toHaveProperty("label");
      expect(props).toHaveProperty("lifetime");
      expect(props).toHaveProperty("purpose");
      const required = schema.required ?? [];
      expect(required).toContain("label");
      expect(required).not.toContain("lifetime");
      expect(required).not.toContain("purpose");
    });
  });

  describe("execute → link + key", () => {
    it("returns text containing the full link and the key; link == base+route+/+token; record pending", async () => {
      const deps = makeDeps();
      const tool = createRequestSecretTool(deps);
      const result = await tool.execute("call-1", { label: "OpenAI API Key" });
      const text = textOf(result);

      const details = result.details as {
        key: string;
        link: string;
        lifetime: Lifetime;
        delivered: boolean;
      };
      // text mentions both the link and the key verbatim
      expect(text).toContain(details.link);
      expect(text).toContain(details.key);

      // link is exactly base + routePath + "?token=" + token (token in the
      // QUERY so the exact-pathname HTTP router matches the route).
      const token = tokenFromLink(details.link);
      expect(details.link).toBe(`${BASE}${ROUTE}?token=${token}`);

      // a real pending record now exists under that key
      expect(deps.store.getStatus(details.key)).toBe("pending");
    });

    it("instructs the agent to relay the link verbatim and that it is one-time / expires", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "db password" });
      const text = textOf(result).toLowerCase();
      expect(text).toContain("verbatim");
      expect(text).toContain("one-time");
      expect(text).toMatch(/expire/);
    });

    it("teaches the {{secret:<key>}} placeholder usage with the actual key", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "stripe key" });
      const text = textOf(result);
      const { key } = result.details as { key: string };
      // the literal placeholder instruction includes THIS key
      expect(text).toContain(`{{secret:${key}}}`);
    });
  });

  describe("never leaks a value", () => {
    it("never contains the phrase 'secret value' and carries no value field in details", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "token" });
      const text = textOf(result);
      // There is no value yet; the text must not claim to carry one.
      expect(text.toLowerCase()).not.toContain("secret value");
      const details = result.details as Record<string, unknown>;
      expect(details).not.toHaveProperty("value");
      // sanity: only the intended structured fields are present
      expect(Object.keys(details).sort()).toEqual(
        ["delivered", "key", "lifetime", "link"].sort(),
      );
    });
  });

  describe("lifetime handling", () => {
    it("passes a lifetime override through to store.create", async () => {
      const deps = makeDeps();
      const spy = vi.spyOn(deps.store, "create");
      const tool = createRequestSecretTool(deps);
      await tool.execute("c", { label: "api", lifetime: "session" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("api", "session");
    });

    it("uses defaultLifetime when no override is given", async () => {
      const deps = makeDeps({ defaultLifetime: "ttl" });
      const spy = vi.spyOn(deps.store, "create");
      const tool = createRequestSecretTool(deps);
      const result = await tool.execute("c", { label: "api" });
      expect(spy).toHaveBeenCalledWith("api", "ttl");
      expect((result.details as { lifetime: Lifetime }).lifetime).toBe("ttl");
    });

    it("reports the effective lifetime in details", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "api", lifetime: "session" });
      expect((result.details as { lifetime: Lifetime }).lifetime).toBe("session");
    });
  });

  describe("base-url warning passthrough", () => {
    it("includes the warning text when getBaseUrl returns one", async () => {
      const warning = "Link is only reachable on the gateway host — set publicUrl.";
      const tool = createRequestSecretTool(
        makeDeps({ getBaseUrl: () => ({ url: "http://127.0.0.1:18789", warning }) }),
      );
      const result = await tool.execute("c", { label: "api" });
      expect(textOf(result)).toContain(warning);
    });

    it("omits warning-related noise when there is no warning", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "api" });
      // base has no warning; just assert execute still succeeds with a link
      expect(textOf(result)).toContain((result.details as { link: string }).link);
    });
  });

  describe("direct delivery (best-effort)", () => {
    it("calls deliver once with the link and reports delivered:true", async () => {
      const deliver = vi.fn(async () => {});
      const tool = createRequestSecretTool(makeDeps({ deliver }));
      const result = await tool.execute("c", { label: "api" });
      const link = (result.details as { link: string }).link;
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(link);
      expect((result.details as { delivered: boolean }).delivered).toBe(true);
    });

    it("tells the agent the link was already sent when delivery succeeded", async () => {
      const deliver = vi.fn(async () => {});
      const tool = createRequestSecretTool(makeDeps({ deliver }));
      const result = await tool.execute("c", { label: "api" });
      expect(textOf(result).toLowerCase()).toMatch(/already sent|sent to the user|sent it/);
    });

    it("does NOT throw when deliver rejects; reports delivered:false and still returns the link", async () => {
      const deliver = vi.fn(async () => {
        throw new Error("channel down");
      });
      const deps = makeDeps({ deliver });
      const tool = createRequestSecretTool(deps);
      const result = await tool.execute("c", { label: "api" });
      const details = result.details as { delivered: boolean; link: string; key: string };
      expect(details.delivered).toBe(false);
      // link still present and record still created
      expect(textOf(result)).toContain(details.link);
      expect(deps.store.getStatus(details.key)).toBe("pending");
    });

    it("handles a synchronous-throwing deliver without throwing out of execute", async () => {
      const deliver = vi.fn(() => {
        throw new Error("sync boom");
      });
      const tool = createRequestSecretTool(makeDeps({ deliver }));
      const result = await tool.execute("c", { label: "api" });
      expect((result.details as { delivered: boolean }).delivered).toBe(false);
    });

    it("reports delivered:false when no deliver is provided", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "api" });
      expect((result.details as { delivered: boolean }).delivered).toBe(false);
    });
  });

  describe("ToolResult content shape", () => {
    it("returns at least one text content block", async () => {
      const tool = createRequestSecretTool(makeDeps());
      const result = await tool.execute("c", { label: "api" });
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThanOrEqual(1);
      expect(result.content[0].type).toBe("text");
    });
  });
});
