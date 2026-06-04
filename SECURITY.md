# Security Policy

**One-Time Secret Tunnel** (`@mcxiaoguu/secret-tunnel`) exists to *reduce* the risk of secrets leaking into an AI agent's context. Because it handles credentials, here is precisely what it protects, what it does **not**, and how to report problems.

## What it protects

- **The secret value never enters the model's context, transcript, or logs.** The agent only ever sees an opaque `key`. The value is submitted out-of-band via a one-time link and injected into a tool call at the execution boundary by swapping a `{{secret:<key>}}` placeholder.
- **The plugin never persists the value.** It is held only in process memory as a `Buffer`, zeroed in place on wipe, and removed from both lookup maps after use.
- **Single-use by default.** The value is wiped immediately after the first resolve (`use-once`; also configurable `session` / `ttl`), and always wiped on `session_end` and `gateway_stop`.
- **Out-of-band transport.** Only a one-time, single-submission, short-expiry capability link travels the chat channel — never the secret. With **Tailscale Funnel**, TLS terminates on the gateway, so the value is end-to-end encrypted to your machine and the tunnel provider cannot read it.
- **Defense in depth.** `message_sending` and `tool_result_persist` hooks redact any live secret value that a tool accidentally echoes into an outbound message or a persisted result.

## Honest limitations (threat model)

- **A compromised or prompt-injected agent can still *direct* the resolved value into a tool call it controls.** The value never enters the model's context, but the resolver fills `{{secret:<key>}}` wherever the agent places it. Per-secret allowed-tool constraints are planned, not yet implemented.
- **The one-time link is a bearer capability** — whoever opens it first may submit. Mitigated by single-use, short expiry, and a 32-byte high-entropy token; still, treat the link as sensitive.
- **Transport security depends on the operator's reachability choice.** Tailscale Funnel keeps the value encrypted to the gateway. A TLS-terminating tunnel (Cloudflare Tunnel, ngrok, etc.) would let that provider observe the submitted value — **prefer Funnel for secrets**, or add client-side encryption (planned).
- **Not hardened against an attacker with OS-level memory access** to the gateway process. JS strings created at resolve time cannot be explicitly zeroed; Buffer storage minimizes the lingering copy.
- **Downstream handling is out of scope.** Once a tool receives the value, what it does with it is the operator's responsibility.

## Reporting a vulnerability

Please report security issues **privately**:

- GitHub → the [`claw-secret-tunnel`](https://github.com/MCxiaoguu/claw-secret-tunnel) repo → **Security → Report a vulnerability** (private advisory), **or**
- open a minimal issue asking for a private contact channel (no exploit details in the public issue).

Please do not disclose details publicly until a fix is released. We aim to acknowledge reports promptly and credit reporters who wish to be named.

## Scope

This policy covers the plugin code in this repository. It does **not** cover the OpenClaw gateway itself, ClawHub, or the operator's deployment and reachability configuration.
