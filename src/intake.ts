import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRouteHandler } from "./openclaw.js";
import type { SecretStore } from "./store.js";

/**
 * The one-time intake form — the ONLY place a secret value enters this process.
 *
 * Security posture (spec §5(b),§6):
 * - The value arrives via POST and is handed straight to {@link SecretStore.fill};
 *   it is NEVER logged, NEVER echoed back in any response, and NEVER persisted
 *   anywhere but the store. The handler intentionally takes no logger.
 * - Request bodies are size-capped (1 MiB) and the connection is destroyed on
 *   overflow so an oversized upload can't exhaust memory.
 * - The label rendered into the form is HTML-escaped to prevent reflected XSS.
 *
 * Routing (verified against the real OpenClaw gateway): the plugin HTTP router
 * dispatches by EXACT pathname match
 * (`src/gateway/server/plugins-http.ts`: `routes.find(e => e.path === url.pathname)`),
 * so a request to `<routePath>/<token>` does NOT reach a handler registered at
 * `<routePath>`. To be robust regardless of how the link is minted, the token
 * is parsed from EITHER the path tail (`<routePath>/<token>`) OR a `?token=` /
 * `?t=` query param. If the orchestrator switches the minted link to the
 * exact-match-friendly `<routePath>?token=<token>` form, this handler already
 * supports it.
 */

/** Hard cap on the POST body we will buffer before rejecting with 413. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

/** Minimal, dependency-free HTML entity escape for text/attribute contexts. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", HTML_HEADERS["Content-Type"]);
  res.end(html);
}

function pageShell(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${safeTitle}</title>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** The single-field capture form for a pending record. `label` is escaped here. */
function formPage(label: string): string {
  const safeLabel = escapeHtml(label);
  // The form posts to the SAME URL (action omitted) so the token in the path or
  // query is preserved. No secret value is ever interpolated into this HTML.
  const body = `<main>
<h1>Provide your ${safeLabel}</h1>
<p>This is a secure, one-time link. The value you submit is used directly and is
never stored long-term or shown to the assistant. Submit it once, then close this tab.</p>
<form method="POST" autocomplete="off">
<label>${safeLabel}<br>
<input type="password" name="secret" autofocus autocomplete="off" required>
</label>
<br>
<button type="submit">Submit</button>
</form>
</main>`;
  return pageShell(`Provide your ${label}`, body);
}

function invalidLinkPage(): string {
  return pageShell(
    "Invalid link",
    `<main><h1>Invalid link</h1><p>This link is not valid. Please ask for a new one.</p></main>`,
  );
}

function expiredPage(): string {
  return pageShell(
    "Link expired",
    `<main><h1>Link expired</h1><p>This one-time link has expired. Please ask for a new one.</p></main>`,
  );
}

function alreadyUsedPage(): string {
  return pageShell(
    "Already used",
    `<main><h1>Already used</h1><p>This one-time link has already been used. Please ask for a new one.</p></main>`,
  );
}

function rejectedSubmissionPage(): string {
  return pageShell(
    "Could not accept",
    `<main><h1>Could not accept</h1><p>This link is invalid, expired, or already used. Please ask for a new one.</p></main>`,
  );
}

function missingSecretPage(): string {
  return pageShell(
    "Missing value",
    `<main><h1>Missing value</h1><p>No value was provided. Please go back and submit the value.</p></main>`,
  );
}

function tooLargePage(): string {
  return pageShell(
    "Too large",
    `<main><h1>Too large</h1><p>The submitted value is too large.</p></main>`,
  );
}

function receivedPage(): string {
  return pageShell(
    "Received",
    `<main><h1>Received</h1><p>Received — you can close this tab.</p></main>`,
  );
}

/**
 * Extract the token from the request URL. Strips the query string, decodes the
 * path, and if the path is `<routePath>/<tail>` returns the (last) tail
 * segment; otherwise falls back to a `?token=` / `?t=` query param. Returns the
 * empty string when no token can be found.
 */
function extractToken(rawUrl: string, routePath: string): string {
  const url = new URL(rawUrl, "http://localhost");
  const pathname = url.pathname;

  // Normalize the configured route to a no-trailing-slash form for the prefix test.
  const base = routePath.endsWith("/") ? routePath.slice(0, -1) : routePath;
  const prefix = `${base}/`;
  if (pathname.startsWith(prefix)) {
    // Everything after `<routePath>/`. Take the last non-empty segment so a
    // stray trailing slash doesn't yield an empty token.
    const tail = pathname.slice(prefix.length);
    const segments = tail.split("/").filter((s) => s.length > 0);
    const last = segments.length > 0 ? segments[segments.length - 1] : "";
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
  }

  // Query fallback (works with exact-match routers: `<routePath>?token=<token>`).
  const q = url.searchParams.get("token") ?? url.searchParams.get("t");
  return q ?? "";
}

/**
 * Read the request body up to {@link MAX_BODY_BYTES}. Resolves `{ tooLarge:true }`
 * the instant the cap is crossed; otherwise resolves the buffered string.
 *
 * On overflow we STOP buffering (so memory is bounded at ~the cap) and resolve
 * immediately so the caller can answer 413, but we deliberately do NOT destroy
 * the socket here: tearing it down mid-upload makes the client's write fail
 * (EPIPE/ECONNRESET) before it can read our response. Instead we keep the
 * stream flowing in "discard" mode and let the response close the connection
 * gracefully once written. The raw body string is sensitive and is never logged
 * by callers.
 */
function readBody(
  req: IncomingMessage,
): Promise<{ body: string; tooLarge: false } | { body: ""; tooLarge: true }> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    let settled = false;
    let overflow = false;

    const finish = (
      value: { body: string; tooLarge: false } | { body: ""; tooLarge: true },
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on("data", (chunk: Buffer) => {
      if (overflow) return; // already over cap: discard further bytes (no buffering)
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks = null; // release whatever we had buffered
        finish({ body: "", tooLarge: true });
        return;
      }
      chunks!.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        finish({ body: "", tooLarge: true });
        return;
      }
      finish({ body: Buffer.concat(chunks ?? []).toString("utf8"), tooLarge: false });
    });
    req.on("error", (err) => {
      // A client abort after we already decided "too large" isn't an error we
      // care about — we've resolved already. Only surface pre-resolution errors.
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Pull the `secret` field out of a request body. Supports
 * `application/x-www-form-urlencoded` (via {@link URLSearchParams}) and
 * `application/json`. Returns the empty string when absent/blank/unparsable so
 * callers reject uniformly.
 */
function extractSecret(body: string, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object") {
        const value = (parsed as Record<string, unknown>).secret;
        return typeof value === "string" ? value : "";
      }
    } catch {
      return "";
    }
    return "";
  }
  // Default: urlencoded form body.
  const params = new URLSearchParams(body);
  return params.get("secret") ?? "";
}

/**
 * Build the intake {@link HttpRouteHandler}. GET renders the form (or an
 * appropriate error page); POST reads the body and calls {@link SecretStore.fill}.
 * The handler closes over `store` + `routePath` only and never receives or
 * touches a logger.
 */
export function createIntakeHandler(
  store: SecretStore,
  routePath: string,
): HttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const token = extractToken(req.url ?? "/", routePath);

    if (method === "POST") {
      const read = await readBody(req);
      if (read.tooLarge) {
        sendHtml(res, 413, tooLargePage());
        // Drain any remaining inbound bytes (we stopped buffering) so the
        // request stream completes and the connection closes cleanly instead of
        // resetting under the client's still-in-flight write.
        req.resume();
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "");
      const secret = extractSecret(read.body, contentType);
      if (!secret) {
        // No value supplied (missing field or blank). 400.
        sendHtml(res, 400, missingSecretPage());
        return;
      }
      // `fill` is the single authority for unknown/expired/second-submission.
      const ok = store.fill(token, secret);
      if (!ok) {
        sendHtml(res, 400, rejectedSubmissionPage());
        return;
      }
      sendHtml(res, 200, receivedPage());
      return;
    }

    // GET (and any non-POST): render based on the token's current status.
    const info = store.tokenInfo(token);
    if (!info) {
      sendHtml(res, 404, invalidLinkPage());
      return;
    }
    switch (info.status) {
      case "pending":
        sendHtml(res, 200, formPage(info.label));
        return;
      case "expired":
        sendHtml(res, 410, expiredPage());
        return;
      // "filled" | "consumed": the one-time link has already been used.
      default:
        sendHtml(res, 410, alreadyUsedPage());
        return;
    }
  };
}
