# claw-secret-tunnel

> **One-Time Secret Tunnel** — a one-time, out-of-band secret hand-off plugin for [OpenClaw](https://github.com/openclaw/openclaw).

A human hands the agent a secret (API key / password / token) **once**, via a one-time link delivered over the chat channel and opened **out-of-band**. The secret is captured server-side into an in-memory key→value store the **LLM can never read**, resolved into the agent's *own* tool calls at the point of use via a `{{secret:<key>}}` placeholder, and is **single-use** — used once, then wiped; never written to disk, transcript, or logs.

## Why

OpenClaw has no inbound-message redaction, so a secret pasted into chat lands in the model's context *and* the on-disk transcript. Vaults store secrets for reuse; scanners only catch output leaks. Nothing provides a **one-time, never-stored, supplied-in-the-moment** credential hand-off. This plugin does exactly that — and nothing more (storage/use after hand-off is downstream's job).

## How it works

1. The agent calls the `request_secret` tool → the plugin mints a one-time link **server-side** (no hallucinated URLs) and returns it.
2. The link is relayed over the chat channel; the human opens it and pastes the secret into a one-field form.
3. The value is held in memory under a **key**; only the key ever reaches the agent.
4. When the agent puts `{{secret:<key>}}` into one of its own tool calls, a `before_tool_call` hook swaps in the real value at the last instant — then wipes it.

## Transport

The minted link must be reachable from the human's device. Reachability is resolved per request, in this order:

1. **`publicUrl`** (operator-managed reverse proxy / VPS) — TLS terminates on infrastructure you control; no third party can see the secret. Best when the gateway has a public IP or you run your own ingress.
2. **Tailscale Funnel** (opt-in via `detectTailscale: true`) — provider-blind too: Tailscale issues the node its own cert, so TLS terminates on the gateway. Only enable it once `tailscale funnel <gateway-port>` actually works on the box; tailnet HTTPS certs and the funnel node attribute must be enabled first.
3. **Cloudflare Quick Tunnel** (`tunnel: "cloudflared"`, the **default**) — zero-config: `request_secret` spawns `cloudflared tunnel --url http://127.0.0.1:<port>` on demand, mints the link on the returned `https://*.trycloudflare.com` URL, and tears the tunnel down once no link is open (link expiry + 30 s grace). No account, no domain, works behind any NAT. Requires the [`cloudflared` binary](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the gateway's `PATH`.
4. Otherwise the link falls back to `http://127.0.0.1:<port>` and the tool result warns that it is only reachable on the gateway host.

> **Trade-off (read this):** quick tunnels terminate TLS at Cloudflare's edge, so Cloudflare *could* observe a submitted value in transit. The exposure is bounded — the tunnel exists only while a one-time link is open — but operators with stricter requirements should use `publicUrl` or Tailscale Funnel, where the provider sees only ciphertext. Details in [SECURITY.md](SECURITY.md). Client-side (in-browser) encryption of the submitted value is planned to close this gap.

## Status

**v0.1.1 — published on ClawHub** as `@mcxiaoguu/secret-tunnel` (family: code-plugin). To run it on a gateway, use `scripts/install-on-gateway.sh` (clone + build + enable + self-test), which also checks for the `cloudflared` binary the default tunnel needs.
