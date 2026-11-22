/**
 * Cloudflare Turnstile server-side token verification for /api/newsletter/subscribe (routes.ts).
 * Ported from harbouredgetraining apps/web/src/modules/newsletter/turnstile.ts.
 *
 * - No secret: refused everywhere except a local dev server, where it is skipped with a warning.
 *   Production must never accept a form unchecked because a secret went missing.
 * - The always-passing test secret: accepted only on a local dev server; refused on every other host.
 * - siteverify unreachable, non-JSON, 5xx or `internal-error`: one retry with the same idempotency
 *   key (so a first call that did reach Cloudflare isn't answered `timeout-or-duplicate`), then the
 *   visitor gets a 503 "try again in a minute" instead of the "verification failed" they can't fix.
 *
 * Every refusal for a reason on our side logs one structured `evt: "turnstile"` error line; a bad
 * visitor token logs an info line.
 */

export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** URL.hostname values of a local dev server (an IPv6 hostname keeps its brackets). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 300;
const HTTP_SERVER_ERROR = 500;

type FailureReason =
  | "missing_token"
  | "invalid"
  | "not_configured"
  | "unavailable";

export interface TurnstileFailure {
  message: string;
  ok: false;
  reason: FailureReason;
  status: 400 | 503;
}
export type TurnstileResult = { ok: true } | TurnstileFailure;

export const TURNSTILE_MESSAGES = {
  invalid: "Security verification failed. Please try again.",
  missing_token: "Security verification required",
  not_configured:
    "Security verification is unavailable right now. Please try again later.",
  unavailable:
    "We couldn't complete the security check just now. Please try again in a minute.",
} as const;

const fail = (reason: FailureReason): TurnstileFailure => ({
  message: TURNSTILE_MESSAGES[reason],
  ok: false,
  reason,
  status: reason === "missing_token" || reason === "invalid" ? 400 : 503,
});

/** Error codes that mean our secret or our request is wrong, not the visitor's token. */
const SECRET_ERRORS = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
]);

/** The part of `fetch` used here (the global's type also carries Bun's `preconnect`). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type Attempt =
  | { kind: "ok" }
  | { kind: "invalid"; codes: string[] }
  | { kind: "secret"; codes: string[] }
  | { kind: "unavailable"; error: string };

interface SiteverifyBody {
  "error-codes"?: unknown;
  success?: unknown;
}

async function siteverify(
  f: FetchLike,
  body: string,
  timeoutMs: number
): Promise<Attempt> {
  let response: Response;
  try {
    response = await f(SITEVERIFY_URL, {
      body,
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return { error: `${err.name}: ${err.message}`, kind: "unavailable" };
  }
  const data = (await response
    .json()
    .catch(() => null)) as SiteverifyBody | null;
  if (!data || typeof data.success !== "boolean") {
    return {
      error: `HTTP ${response.status}, no JSON verdict`,
      kind: "unavailable",
    };
  }
  if (data.success) {
    return { kind: "ok" };
  }
  const codes = Array.isArray(data["error-codes"])
    ? data["error-codes"].map(String)
    : [];
  if (
    codes.includes("internal-error") ||
    response.status >= HTTP_SERVER_ERROR
  ) {
    return {
      error: `HTTP ${response.status} ${codes.join(",")}`,
      kind: "unavailable",
    };
  }
  if (codes.some((c) => SECRET_ERRORS.has(c))) {
    return { codes, kind: "secret" };
  }
  return { codes, kind: "invalid" };
}

type LogLevel = "error" | "info";

export interface CheckTurnstileOptions {
  fetch?: FetchLike;
  /** The request's hostname (new URL(request.url).hostname). */
  host: string;
  log?: (line: string, level: LogLevel) => void;
  remoteIp?: string | null;
  retryDelayMs?: number;
  secretKey: string | undefined;
  timeoutMs?: number;
  token: string | undefined;
}

/** The secret-related checks before any siteverify call: `null` when siteverify should run. */
function checkSecret(
  secretKey: string | undefined,
  host: string,
  logError: (outcome: string, detail: Record<string, unknown>) => void
): TurnstileResult | null {
  if (!secretKey) {
    if (LOCAL_HOSTS.has(host)) {
      console.warn(
        "TURNSTILE_SECRET_KEY unset: skipping Turnstile on a local dev server"
      );
      return { ok: true };
    }
    logError("not_configured", { error: "TURNSTILE_SECRET_KEY unset" });
    return fail("not_configured");
  }
  if (secretKey === TURNSTILE_TEST_SECRET) {
    if (LOCAL_HOSTS.has(host)) {
      // The test secret always passes.
      return { ok: true };
    }
    logError("not_configured", { error: "test secret outside local dev" });
    return fail("not_configured");
  }
  return null;
}

export async function checkTurnstile(
  opts: CheckTurnstileOptions
): Promise<TurnstileResult> {
  const { token, secretKey, host } = opts;
  const f: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const log =
    opts.log ??
    ((line: string, level: LogLevel) =>
      level === "error" ? console.error(line) : console.log(line));
  const logLine = (
    level: LogLevel,
    outcome: string,
    detail: Record<string, unknown> = {}
  ) =>
    log(JSON.stringify({ evt: "turnstile", host, outcome, ...detail }), level);
  const logError = (outcome: string, detail: Record<string, unknown> = {}) =>
    logLine("error", outcome, detail);

  if (!token) {
    return fail("missing_token");
  }
  const secretResult = checkSecret(secretKey, host, logError);
  if (secretResult) {
    return secretResult;
  }

  const body = JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    response: token,
    secret: secretKey,
    ...(opts.remoteIp && { remoteip: opts.remoteIp }),
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let attempt = await siteverify(f, body, timeoutMs);
  if (attempt.kind === "unavailable") {
    await new Promise((r) =>
      setTimeout(r, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    );
    const first = attempt.error;
    attempt = await siteverify(f, body, timeoutMs);
    if (attempt.kind === "unavailable") {
      logError("unavailable", {
        attempts: 2,
        error: attempt.error,
        firstError: first,
      });
      return fail("unavailable");
    }
  }
  if (attempt.kind === "ok") {
    return { ok: true };
  }
  if (attempt.kind === "secret") {
    logError("not_configured", {
      codes: attempt.codes,
      error: "siteverify rejected the secret or request",
    });
    return fail("not_configured");
  }
  // The visitor's token: expired, reused or forged. Not an incident.
  logLine("info", "invalid", { codes: attempt.codes });
  return fail("invalid");
}
