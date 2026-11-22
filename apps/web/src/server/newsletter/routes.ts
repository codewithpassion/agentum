/**
 * `POST /api/newsletter/subscribe`: the landing page's newsletter form, through our own backend.
 * The browser never talks to the newsletters app. This route checks the address and the honeypot,
 * verifies the Turnstile token (failing closed), and only then makes one call to the newsletters
 * API with our key. The API's own error text never reaches the browser.
 */
import { Hono } from "hono";
import { checkTurnstile } from "./turnstile";

export const NEWSLETTERS_API = "https://newsletters.rockyshoreslabs.io/api/v1";

/** The bindings the route reads. All three are Worker secrets. */
export interface NewsletterEnv {
  NEWSLETTERS_API_KEY?: string;
  NEWSLETTERS_NEWSLETTER_ID?: string;
  TURNSTILE_SECRET_KEY?: string;
}

/** The part of `fetch` used here (the global's type also carries Bun's `preconnect`). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const MESSAGES = {
  generic: "Something went wrong, please try again.",
  invalidEmail: "Please enter a valid email address.",
  rateLimited: "Too many attempts, try again in a few minutes.",
  sent: "Check your inbox to confirm your subscription.",
} as const;

const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;
const MAX_EMAIL_LENGTH = 254;
const API_TIMEOUT_MS = 10_000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const isValidEmail = (email: unknown): email is string =>
  typeof email === "string" &&
  email.length <= MAX_EMAIL_LENGTH &&
  !CONTROL_CHARS.test(email) &&
  EMAIL_SHAPE.test(email);

interface FormBody {
  email?: unknown;
  turnstileToken?: unknown;
  website?: unknown;
}

const log = (evt: Record<string, unknown>) =>
  console.log(JSON.stringify({ evt: "newsletter_signup", ...evt }));
/** A fault on our side (config, upstream): an error line, so it stands out in the Worker logs. */
const logError = (evt: Record<string, unknown>) =>
  console.error(JSON.stringify({ evt: "newsletter_signup", ...evt }));

/** One POST to the newsletters API. No `skipConfirmation`: the double opt-in email goes out. */
async function subscribe(
  f: FetchLike,
  env: NewsletterEnv,
  email: string
): Promise<number | null> {
  const { NEWSLETTERS_API_KEY: apiKey, NEWSLETTERS_NEWSLETTER_ID: id } = env;
  if (!(apiKey && id)) {
    logError({ outcome: "not_configured" });
    return null;
  }
  try {
    const response = await f(
      `${NEWSLETTERS_API}/newsletters/${encodeURIComponent(id)}/subscribers`,
      {
        body: JSON.stringify({ email, tags: [] }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      }
    );
    return response.status;
  } catch (e) {
    logError({
      error: e instanceof Error ? e.name : "unknown",
      outcome: "network",
    });
    return null;
  }
}

/** `fetchImpl` is for tests: the Turnstile check and the newsletters call both go through it. */
export const newsletterRoutes = (
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
) =>
  new Hono<{ Bindings: NewsletterEnv }>().post(
    "/api/newsletter/subscribe",
    async (c) => {
      const body: FormBody | null = await c.req.json().catch(() => null);
      if (!isValidEmail(body?.email)) {
        return c.json(
          { message: MESSAGES.invalidEmail, ok: false },
          HTTP_BAD_REQUEST
        );
      }
      // A person never sees this field. Anything in it is a bot.
      if (body.website) {
        log({ outcome: "honeypot" });
        return c.json(
          { message: MESSAGES.generic, ok: false },
          HTTP_BAD_REQUEST
        );
      }

      const turnstile = await checkTurnstile({
        fetch: fetchImpl,
        host: new URL(c.req.url).hostname,
        remoteIp: c.req.header("CF-Connecting-IP"),
        secretKey: c.env.TURNSTILE_SECRET_KEY,
        token:
          typeof body.turnstileToken === "string"
            ? body.turnstileToken
            : undefined,
      });
      if (!turnstile.ok) {
        return c.json(
          { message: turnstile.message, ok: false },
          turnstile.status
        );
      }

      const status = await subscribe(fetchImpl, c.env, body.email);
      if (status !== null && status >= 200 && status < 300) {
        return c.json({ message: MESSAGES.sent, ok: true });
      }
      if (status !== null) {
        logError({ httpStatus: status, outcome: "upstream" });
      }
      if (status === HTTP_UNPROCESSABLE) {
        return c.json(
          { message: MESSAGES.invalidEmail, ok: false },
          HTTP_UNPROCESSABLE
        );
      }
      if (status === HTTP_TOO_MANY) {
        return c.json(
          { message: MESSAGES.rateLimited, ok: false },
          HTTP_TOO_MANY
        );
      }
      return c.json({ message: MESSAGES.generic, ok: false }, HTTP_BAD_GATEWAY);
    }
  );
