import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  MESSAGES,
  NEWSLETTERS_API,
  type NewsletterEnv,
  newsletterRoutes,
} from "./routes";
import { TURNSTILE_MESSAGES, TURNSTILE_TEST_SECRET } from "./turnstile";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const NEWSLETTER_ID = "nl-1";
const API_URL = `${NEWSLETTERS_API}/newsletters/${NEWSLETTER_ID}/subscribers`;
const PROD_URL = "https://agentumbot.io/api/newsletter/subscribe";

interface Call {
  init: RequestInit;
  url: string;
}
let calls: Call[] = [];
let siteverifyReply: { success: boolean } = { success: true };
let apiStatus = 201;

const fetchMock = (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ init, url });
  if (url === SITEVERIFY) {
    return Promise.resolve(Response.json(siteverifyReply));
  }
  return Promise.resolve(
    Response.json(
      { error: { message: "upstream secret detail" } },
      { status: apiStatus }
    )
  );
};

const apiCalls = () => calls.filter((c) => c.url !== SITEVERIFY);

const env = (over: Partial<NewsletterEnv> = {}): NewsletterEnv => ({
  NEWSLETTERS_API_KEY: "nl_live_key",
  NEWSLETTERS_NEWSLETTER_ID: NEWSLETTER_ID,
  TURNSTILE_SECRET_KEY: "0x-real",
  ...over,
});

const post = (
  body: unknown,
  environment: NewsletterEnv = env(),
  url = PROD_URL
) =>
  newsletterRoutes(fetchMock).request(
    url,
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    environment
  );

const valid = { email: "a@b.co", turnstileToken: "tok", website: "" };

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  calls = [];
  siteverifyReply = { success: true };
  apiStatus = 201;
});

test("a valid token calls the API once with the right URL, header and body", async () => {
  const response = await post(valid);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ message: MESSAGES.sent, ok: true });
  const [call, ...rest] = apiCalls();
  expect(rest).toHaveLength(0);
  expect(call?.url).toBe(API_URL);
  expect(call?.init.method).toBe("POST");
  expect(call?.init.headers).toEqual({
    Authorization: "Bearer nl_live_key",
    "Content-Type": "application/json",
  });
  expect(JSON.parse(String(call?.init.body))).toEqual({
    email: "a@b.co",
    tags: [],
  });
});

test("no token is refused before the API is called", async () => {
  const response = await post({ email: "a@b.co" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    message: TURNSTILE_MESSAGES.missing_token,
    ok: false,
  });
  expect(apiCalls()).toHaveLength(0);
});

test("a bad token is refused before the API is called", async () => {
  siteverifyReply = { success: false };
  const response = await post(valid);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    message: TURNSTILE_MESSAGES.invalid,
    ok: false,
  });
  expect(apiCalls()).toHaveLength(0);
});

test("a missing Turnstile secret is refused before the API is called", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  const response = await post(valid, env({ TURNSTILE_SECRET_KEY: undefined }));
  expect(response.status).toBe(503);
  expect(calls).toHaveLength(0);
});

test("the test secret on a non-localhost host is refused before the API is called", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  const response = await post(
    valid,
    env({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET })
  );
  expect(response.status).toBe(503);
  expect(calls).toHaveLength(0);
});

test("the test secret passes on localhost", async () => {
  const response = await post(
    valid,
    env({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET }),
    "http://localhost:3000/api/newsletter/subscribe"
  );
  expect(response.status).toBe(200);
  expect(apiCalls()).toHaveLength(1);
});

test("a filled honeypot is refused before anything is called", async () => {
  const response = await post({ ...valid, website: "http://spam.example" });
  expect(response.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test.each([
  ["no email", {}],
  ["not an address", { email: "nope", turnstileToken: "tok" }],
  ["a number", { email: 5, turnstileToken: "tok" }],
  ["a control character", { email: "a\u0000@b.co", turnstileToken: "tok" }],
  ["not JSON", "{"],
])(
  "an invalid email (%s) is refused before anything is called",
  async (_n, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  }
);

test("missing newsletters config answers a generic error and calls no API", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  const response = await post(valid, env({ NEWSLETTERS_API_KEY: undefined }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    message: MESSAGES.generic,
    ok: false,
  });
  expect(apiCalls()).toHaveLength(0);
});

test("an upstream 422 answers the invalid-email message, never the upstream text", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  apiStatus = 422;
  const response = await post(valid);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    message: MESSAGES.invalidEmail,
    ok: false,
  });
});

test("an upstream 429 answers the rate-limited message", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  apiStatus = 429;
  const response = await post(valid);
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    message: MESSAGES.rateLimited,
    ok: false,
  });
});

test("any other upstream failure answers a generic error without upstream text", async () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  apiStatus = 401;
  const response = await post(valid);
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).toBe(JSON.stringify({ message: MESSAGES.generic, ok: false }));
  expect(text).not.toContain("upstream secret detail");
});
