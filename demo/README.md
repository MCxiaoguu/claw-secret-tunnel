# One-Time Secret Tunnel — demo & manual gateway load

Two things live here:

1. **[`run-demo.mjs`](./run-demo.mjs)** — a runnable, self-contained end-to-end demo that drives the **real compiled plugin over real HTTP** and prints every stage so you can *see* the out-of-band, use-once credential flow working.
2. **Manual procedure** (below) to load this plugin into a **real OpenClaw gateway**.

---

## 1. Run the demo

```bash
npm run demo
```

That runs `npm run build` (so `dist/index.js` exists) and then `node demo/run-demo.mjs`. It exits `0` on success, non-zero if any assertion fails.

### What it does (and why it's faithful)

The script does **not** reach into the plugin's individual units. It:

- `import`s the built `./dist/index.js` default export — the exact artifact the gateway loads (`package.json#openclaw.extensions → ./dist/index.js`).
- Constructs a minimal `api` object matching `OpenClawPluginApi` (real `registerTool` / `on` / `registerHttpRoute` / `logger`) that **captures** everything the plugin registers.
- Mounts the captured HTTP route on a **real `http.Server`** and dispatches to it by **exact pathname** — mirroring the gateway's plugin router (`src/gateway/server/plugins-http.ts`: `routes.find(e => e.path === url.pathname)`).
- Binds the server to an **ephemeral port** (`127.0.0.1:0`) and passes `pluginConfig = { publicUrl: "http://127.0.0.1:<port>" }`, so the minted link points back at the demo server. (Ephemeral, not the default `18789`, so the demo never collides with a real gateway you may have running.)
- Then exercises the captured **tool** and **hooks** and makes real `fetch` GET/POST calls to the link.

### The stages it prints (and what each proves)

| Step | What happens | What it proves |
|------|--------------|----------------|
| 1 | **Agent calls `request_secret`** | The tool result the *model* sees contains a one-time link + the `{{secret:<key>}}` usage instruction and **NO secret value** (there is none yet). |
| 2 | **Human opens the link** (real `GET`) | An HTML form comes back containing the human-readable **label** (e.g. "OpenAI API key"), not a value. |
| 3 | **Human submits the secret** (real `POST secret=…`) | HTTP **200**; the value is captured server-side into the in-memory store. The confirmation page echoes **no value**. |
| 4 | **Agent uses it** (`before_tool_call`) | Params **BEFORE** carry the `{{secret:<key>}}` placeholder; params **AFTER** carry the **real value** — this is what the tool executes with, and *the model never saw it*. |
| 5 | **Single-use** (use-once) | The **same** placeholder, used again, is now **blocked** (`{ block, blockReason }`) — the value was wiped the instant it was first resolved. |
| 6 | **Backstop** (`message_sending`) | Using a separate **session**-lifetime secret (one that survives, so we can demonstrate a *live* value), an accidental echo in outbound content is **redacted** to `[redacted-secret]` before send. After `session_end`, the value is wiped and the backstop finds nothing to redact. |
| 7 | **No leak** | Every log line the plugin emitted is dumped; the only one is the static `secret-tunnel registered` — neither secret value ever appears in any log line. |

The use-once secret (`sk-DEMO-1234567890`) is what the agent must never see; it travels the full mint → submit → inject-once → wipe arc (single-use). The session secret (`pg-LIVE-secret-9876543210`) exists only to show the redaction backstop scrubbing a value that is still live.

---

## 2. Load the plugin into a REAL OpenClaw gateway (manual procedure)

The demo proves the flow against the real compiled plugin, but in the demo the gateway surface is reproduced locally. To run it inside an **actual** gateway:

### a. Build the plugin

```bash
npm run build      # produces ./dist/index.js
```

### b. Point `~/.openclaw/openclaw.yaml` at this repo

```yaml
plugins:
  enabled: true
  allow: [secret-tunnel]
  load:
    paths: ["<ABSOLUTE PATH TO THIS REPO>"]
    # e.g. /Users/hanyanggu/Personal_Files/Coding/random_prjs/openclaw_plugin_secret_tunnel
  entries:
    secret-tunnel:
      enabled: true
      config:
        publicUrl: "https://<your-funnel>.ts.net"   # your Tailscale Funnel base URL
```

`publicUrl` is the public HTTPS base the one-time link is built on. With Tailscale Funnel the **human needs no Tailscale** — only the gateway does — and TLS terminates on the gateway, so the secret stays encrypted end-to-end (the tunnel provider never sees it). Leave `publicUrl` blank to auto-detect Tailscale; it falls back to `http://127.0.0.1:18789` (only reachable on the gateway host) with a warning.

### c. Install / link and run

```bash
# from this repo dir — link without copying (equivalent to the load.paths above):
openclaw plugins install -l .

# run the gateway in dev mode (isolated state under ~/.openclaw-dev, shifted ports):
openclaw gateway run --dev
```

### d. (Recommended) loader-backed smoke check

Per the OpenClaw docs these exercise the loader's acceptance gates (manifest + registration) without a fully-configured gateway:

```bash
openclaw plugins validate --entry <ABSOLUTE PATH TO THIS REPO>/dist/index.js
openclaw plugins inspect secret-tunnel --runtime --json
```

### e. Try it

In a session with the gateway running, ask the agent for a credential ("I need you to call the OpenAI API — ask me for the key"). The agent calls `request_secret`; relay/open the minted link, submit the value, and watch the agent use `{{secret:<key>}}` — the value is injected only at the tool boundary and then wiped (single-use).

---

## 3. Real-loader validation status (STRETCH)

We attempted to validate the built plugin through the **real OpenClaw loader/CLI** using the checkout at `/Users/hanyanggu/for_openclaw/openclaw`.

**Result: fell back to the documented manual procedure above — the checkout is not runnable without a heavy build.** Specifics:

- The checkout is **source-only**: it has **no `node_modules`** and **no `dist/`**. `openclaw.mjs` boots by importing `./dist/entry.js`, which does not exist until the project is built.
- Making the CLI runnable requires **two** non-trivial steps, not "a couple of commands":
  1. `pnpm install` — the `pnpm-lock.yaml` resolves **~996 packages across 35 workspace projects**, including native/binary deps (`sharp`, `node-llama-cpp`, `@matrix-org/matrix-sdk-crypto-nodejs`, `esbuild`) with download/build postinstall steps. In this environment the tarball/binary downloads ran far below 50 KiB/s, so the install did not complete within the bounded window.
  2. Even after install, `pnpm build` is required (`tsdown` + a canvas/a2ui asset bundle + several codegen scripts) to produce `dist/entry.js` before `openclaw.mjs` / `openclaw plugins validate` can run at all.
- Per the task's explicit bound ("if `pnpm install` is too slow, fails, or the CLI needs more setup than a couple of commands, STOP and fall back"), we did not rabbit-hole on the monorepo build.

What we **did** verify against the real checkout (source inspection):

- The plugin's default export loads from `dist/index.js` with `id: "secret-tunnel"` and a `register` function — the exact shape `src/plugins/loader.ts` consumes (it passes `pluginConfig: validatedConfig.value` into `register`, matching how the demo supplies `pluginConfig.publicUrl`).
- The gateway's plugin HTTP router dispatches by **exact pathname** (`src/gateway/server/plugins-http.ts:26` → `routes.find((entry) => entry.path === url.pathname)`). The demo's server mirrors this exactly, and the minted link rides the token in the **query string** (`/secret?token=…`) so it matches the exact registered path `/secret` — this is why the link resolves rather than 404-ing.

To complete the loader-backed check on a machine with fast network: in `/Users/hanyanggu/for_openclaw/openclaw` run `pnpm install` then `pnpm build`, then
`node ./openclaw.mjs plugins validate --entry <ABSOLUTE PATH TO THIS REPO>/dist/index.js`.
