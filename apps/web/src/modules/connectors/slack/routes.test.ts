import { describe, expect, mock, test } from "bun:test";
import { signSlackRequest } from "./signature";

// The route reaches `publishMessage`, and through it the router's Durable
// Object, which imports a module only the Workers runtime provides. Stubbing it
// lets the endpoint itself be tested here; nothing in these cases gets that far.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { slackRoutes } = await import("./routes");

/**
 * The endpoint's guards: no credentials, a bad signature, and the handshake.
 * Publishing itself is covered by `ingest.test.ts`, which needs no request.
 */

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const MILLISECONDS = 1000;

const env = (overrides: Partial<Env> = {}): Env =>
  ({
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    ...overrides,
  }) as Env;

const post = async (
  body: unknown,
  options: { env?: Env; signWith?: string | null; timestamp?: string } = {}
) => {
  const rawBody = JSON.stringify(body);
  const timestamp =
    options.timestamp ?? String(Math.floor(Date.now() / MILLISECONDS));
  const secret =
    options.signWith === undefined ? SIGNING_SECRET : options.signWith;

  return await slackRoutes.request(
    "/events",
    {
      body: rawBody,
      headers: {
        "content-type": "application/json",
        ...(secret
          ? {
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": await signSlackRequest(
                secret,
                timestamp,
                rawBody
              ),
            }
          : {}),
      },
      method: "POST",
    },
    options.env ?? env()
  );
};

describe("POST /api/connectors/slack/events", () => {
  test("answers the url_verification handshake", async () => {
    const response = await post({
      challenge: "3eZbrw1aB",
      type: "url_verification",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({
      challenge: "3eZbrw1aB",
    });
  });

  test("refuses a request signed with the wrong secret", async () => {
    const response = await post(
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { signWith: "not-the-signing-secret" }
    );

    expect(response.status).toBe(401);
  });

  test("refuses an unsigned request", async () => {
    const response = await post(
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { signWith: null }
    );

    expect(response.status).toBe(401);
  });

  test("refuses a replayed request", async () => {
    const stale = String(Math.floor(Date.now() / MILLISECONDS) - 60 * 10);
    const response = await post(
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { timestamp: stale }
    );

    expect(response.status).toBe(401);
  });

  test("reports 503 when the connector has no credentials", async () => {
    const response = await post(
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { env: env({ SLACK_BOT_TOKEN: "", SLACK_SIGNING_SECRET: "" }) }
    );

    // No signing secret means no way to trust the request - so it is refused
    // rather than silently dropped, and the operator sees why.
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toEqual({
      error: "Slack is not configured on this deployment.",
    });
  });

  test("acknowledges an event type it does not handle", async () => {
    const response = await post({ type: "app_rate_limited" });

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ ok: true });
  });
});
