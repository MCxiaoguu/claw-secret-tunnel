# claw-secret-tunnel

> **Credential Vanisher** — a one-time, out-of-band credential pass-through plugin for [OpenClaw](https://github.com/openclaw/openclaw).

A human hands the agent a secret (API key / password / token) **once**, via a one-time link delivered over the chat channel and opened **out-of-band**. The secret is captured server-side into an in-memory key→value store the **LLM can never read**, resolved into the agent's *own* tool calls at the point of use via a `{{secret:<key>}}` placeholder, and then **vanishes** — never written to disk, transcript, or logs.

## Why

OpenClaw has no inbound-message redaction, so a secret pasted into chat lands in the model's context *and* the on-disk transcript. Vaults store secrets for reuse; scanners only catch output leaks. Nothing provides a **one-time, never-stored, supplied-in-the-moment** credential hand-off. This plugin does exactly that — and nothing more (storage/use after hand-off is downstream's job).

## How it works

1. The agent calls the `request_secret` tool → the plugin mints a one-time link **server-side** (no hallucinated URLs) and returns it.
2. The link is relayed over the chat channel; the human opens it and pastes the secret into a one-field form.
3. The value is held in memory under a **key**; only the key ever reaches the agent.
4. When the agent puts `{{secret:<key>}}` into one of its own tool calls, a `before_tool_call` hook swaps in the real value at the last instant — then wipes it.

## Transport

**Tailscale Funnel** by default: the user needs no Tailscale (only the gateway does), and TLS terminates on the gateway so the secret stays encrypted end-to-end — the tunnel provider never sees it.

## Status

**In development.** See the design spec: [`docs/superpowers/specs/2026-06-03-credential-vanisher-design.md`](docs/superpowers/specs/2026-06-03-credential-vanisher-design.md).
