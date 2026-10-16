import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifySlackRequest } from "@repo/services/slack/signature";
import { serve, spawn } from "bun";
import { type FetchLike, replayFixture } from "./slack-replay.ts";

const SECRET = "test-signing-secret";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const SCRIPT = join(import.meta.dir, "slack-replay.ts");
const MENTION = "fixtures/mention.json";
const MENTION_TEXT = readFileSync(join(import.meta.dir, MENTION), "utf8");

interface Recorded {
  body: string;
  headers: Headers;
  url: string;
}

/** A fetch that records each call and answers with the given response. */
const fakeFetch = (answer: () => Response) => {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      body: String(init.body),
      headers: new Headers(init.headers),
      url,
    });
    return Promise.resolve(answer());
  };
  return { calls, fetch };
};

/** The only element of a list the test expects to have. */
const one = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) {
    throw new Error("expected a recorded call");
  }
  return item;
};

type Payload = Record<string, unknown>;

const parsed = (text: string): Payload => JSON.parse(text) as Payload;

const withoutEventId = (payload: Payload): Payload =>
  Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "event_id")
  );

/** True when the call's signature verifies for its own body and headers. */
const signatureVerifies = (call: Recorded): Promise<boolean> =>
  verifySlackRequest({
    body: call.body,
    now: NOW,
    signature: call.headers.get("X-Slack-Signature") ?? "",
    signingSecret: SECRET,
    timestamp: call.headers.get("X-Slack-Request-Timestamp") ?? "",
  });

const replay = (
  fetch: FetchLike,
  overrides: Partial<Parameters<typeof replayFixture>[0]> = {}
) =>
  replayFixture({
    fetch,
    fixturePath: MENTION,
    fresh: false,
    now: NOW,
    secret: SECRET,
    url: "http://localhost:3000/api/slack/events",
    ...overrides,
  });

const okRun = () =>
  new Response(JSON.stringify({ ok: true, runId: "run_123" }), {
    status: 200,
  });

test("the signature verifies against the exact body sent", async () => {
  const { calls, fetch } = fakeFetch(okRun);
  await replay(fetch);

  const call = one(calls);
  expect(call.url).toBe("http://localhost:3000/api/slack/events");
  expect(call.headers.get("Content-Type")).toBe("application/json");
  expect(call.headers.get("X-Slack-Request-Timestamp")).toBe(
    String(Math.floor(NOW / 1000))
  );
  expect(await signatureVerifies(call)).toBe(true);
});

test("the body is the fixture text, byte for byte, without --fresh", async () => {
  const { calls, fetch } = fakeFetch(okRun);
  await replay(fetch);

  expect(one(calls).body).toBe(MENTION_TEXT);
});

test("a successful event prints its run id", async () => {
  const { fetch } = fakeFetch(okRun);
  const result = await replay(fetch);

  expect(result).toEqual({ output: "run_123", status: 200 });
});

test("an ok answer without a run prints no run", async () => {
  const { fetch } = fakeFetch(
    () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  const result = await replay(fetch);

  expect(result).toEqual({ output: "no run", status: 200 });
});

test("--fresh changes only event_id, and the signature still verifies", async () => {
  const { calls, fetch } = fakeFetch(okRun);
  await replay(fetch, { fresh: true });
  await replay(fetch, { fresh: true });

  const [first, second] = calls;
  if (!(first && second)) {
    throw new Error("expected two recorded calls");
  }
  const original = parsed(MENTION_TEXT);
  const firstPayload = parsed(first.body);

  expect(firstPayload.event_id).not.toBe(original.event_id);
  expect(parsed(second.body).event_id).not.toBe(firstPayload.event_id);
  expect(String(firstPayload.event_id).startsWith("Ev")).toBe(true);
  expect(withoutEventId(firstPayload)).toEqual(withoutEventId(original));
  expect(await signatureVerifies(first)).toBe(true);
});

test("a url_verification prints the challenge text", async () => {
  const { fetch } = fakeFetch(
    () =>
      new Response("3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7", {
        status: 200,
      })
  );
  const result = await replay(fetch, {
    fixturePath: "fixtures/url-verification.json",
  });

  expect(result).toEqual({
    output: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7",
    status: 200,
  });
});

test("a 401 answer reports the status and body with status 401", async () => {
  const { fetch } = fakeFetch(
    () => new Response("invalid signature", { status: 401 })
  );
  const result = await replay(fetch);

  expect(result).toEqual({
    output: "HTTP 401: invalid signature",
    status: 401,
  });
});

test("a 401 from the route exits with status 1 and the text on stderr", async () => {
  const server = serve({
    fetch: () => new Response("invalid signature", { status: 401 }),
    port: 0,
  });
  try {
    const proc = spawn(
      [
        process.execPath,
        SCRIPT,
        MENTION,
        "--secret",
        SECRET,
        "--url",
        `http://localhost:${server.port}/api/slack/events`,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("HTTP 401: invalid signature");
    expect(stdout).toBe("");
  } finally {
    server.stop(true);
  }
});
