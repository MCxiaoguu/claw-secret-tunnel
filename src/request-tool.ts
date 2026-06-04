import { Type } from "@sinclair/typebox";
import type { AgentTool, ToolResult } from "./openclaw.js";
import type { Lifetime } from "./types.js";
import type { SecretStore } from "./store.js";

/**
 * The `request_secret` tool — the agent-facing front door of the Credential
 * Vanisher. It mints a one-time intake link + an agent-facing key and returns
 * them as a tool result. It NEVER returns (or even possesses) a secret value:
 * at this point only a `pending` record exists. The value is captured later,
 * out-of-band, via the link, and is injected into the agent's OWN tool calls at
 * point-of-use by the resolver (see spec §5/§6/§7/§10).
 *
 * Anti-hallucination (spec §10): the full link is minted server-side here, so
 * the agent never assembles a URL from parts and cannot fabricate one. When a
 * direct-channel `deliver` is wired, the link is sent to the human directly and
 * the agent is merely told to ask them to open it; otherwise the agent is told
 * to relay the link verbatim.
 */
export function createRequestSecretTool(deps: {
  /** Ephemeral secret store; `create` mints the pending record + token/key. */
  store: SecretStore;
  /**
   * Resolves the public base URL (and optional reachability warning) at call
   * time. `index.ts` binds this to `() => resolveBaseUrl(config)`. Evaluated per
   * call so a late-configured `publicUrl` / Tailscale state is picked up.
   */
  getBaseUrl: () => { url: string; warning?: string };
  /** Intake route path the link is built on, e.g. "/vanish". */
  routePath: string;
  /** Lifetime applied when the agent does not override it. */
  defaultLifetime: Lifetime;
  /**
   * Optional best-effort direct-channel send of the link to the human. Any
   * failure is swallowed (the verbatim-relay path is the fallback); `execute`
   * never throws because of it.
   */
  deliver?: (link: string) => Promise<void> | void;
}): AgentTool {
  const { store, getBaseUrl, routePath, defaultLifetime, deliver } = deps;

  const parameters = Type.Object(
    {
      label: Type.String({
        minLength: 1,
        description:
          "Short human-readable name for the credential being requested, " +
          "e.g. 'OpenAI API key' or 'Postgres password'. Shown to the human on " +
          "the intake form and used to derive the reference key.",
      }),
      lifetime: Type.Optional(
        Type.Union(
          [
            Type.Literal("use-once"),
            Type.Literal("session"),
            Type.Literal("ttl"),
          ],
          {
            description:
              "How long the value may be used after the human submits it. " +
              "'use-once' (default) wipes it the first time it is injected; " +
              "'session' keeps it for the task (wiped on session end / idle); " +
              "'ttl' wipes it a fixed number of seconds after submission. " +
              "Omit to use the configured default.",
          },
        ),
      ),
      purpose: Type.Optional(
        Type.String({
          description:
            "Optional one-line explanation of what the credential is for. " +
            "May be shown to the human for context. Never include any secret here.",
        }),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Request a credential from the human out-of-band. Returns a one-time " +
        "link to relay (or that is sent directly) plus a reference key. You " +
        "never receive the value itself.",
    },
  );

  const description =
    "Request a secret/credential from the human WITHOUT ever seeing its value. " +
    "Call this whenever you need an API key, password, token, or other secret. " +
    "It returns (a) a one-time link the human opens to submit the value, and " +
    "(b) a reference KEY. Relay the link verbatim to the human (or, if it was " +
    "sent directly, ask them to open it). Later, to USE the secret, put the " +
    "placeholder {{secret:<KEY>}} wherever the value belongs in your OWN tool " +
    "calls — the real value is injected at the moment of use and you never see it.";

  function buildText(args: {
    key: string;
    link: string;
    lifetime: Lifetime;
    deliveredOk: boolean;
    warning?: string;
  }): string {
    const { key, link, lifetime, deliveredOk, warning } = args;
    const lines: string[] = [];

    if (deliveredOk) {
      lines.push(
        `The one-time link was already sent to the user directly. Ask them to open it and submit the value:`,
        `  ${link}`,
      );
    } else {
      lines.push(
        `Send this one-time link to the user VERBATIM (do not alter, shorten, or describe it — paste it exactly):`,
        `  ${link}`,
      );
    }

    lines.push(
      "",
      `This link is ONE-TIME: it can be submitted only once and it expires. If it expires or is used, request a new secret.`,
      "",
      `Reference key: ${key}`,
      `Lifetime: ${lifetime}.`,
      "",
      `When you need this secret, put the placeholder {{secret:${key}}} ` +
        `(of the form {{secret:<the actual key>}}) wherever the value belongs in ` +
        `your own tool calls — the real value is injected at the moment of use and ` +
        `you will never see it. Do not ask the user to paste the value into the chat.`,
    );

    if (warning) {
      lines.push("", `Note: ${warning}`);
    }

    return lines.join("\n");
  }

  async function execute(
    _callId: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const label = String((params as { label?: unknown }).label ?? "");
    const lifetime =
      ((params as { lifetime?: Lifetime }).lifetime ?? defaultLifetime) as Lifetime;

    // 1. Mint the pending record (token = URL capability, key = agent handle).
    const { key, token } = store.create(label, lifetime);

    // 2. Build the authoritative link server-side (agent never assembles it).
    const base = getBaseUrl();
    const link = `${base.url}${routePath}/${token}`;

    // 3. Best-effort direct delivery; never let a delivery failure escape.
    let deliveredOk = false;
    if (deliver) {
      try {
        await deliver(link);
        deliveredOk = true;
      } catch {
        deliveredOk = false;
      }
    }

    // 4. Instruct the agent. Contains the key + link, NEVER a value (there is none).
    const text = buildText({
      key,
      link,
      lifetime,
      deliveredOk,
      warning: base.warning,
    });

    return {
      content: [{ type: "text", text }],
      // Structured echo for tooling/inspection — never a value.
      details: { key, link, lifetime, delivered: deliveredOk },
    };
  }

  return { name: "request_secret", description, parameters, execute };
}
