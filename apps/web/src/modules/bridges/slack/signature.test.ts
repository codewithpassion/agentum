import { describe, expect, test } from "bun:test";
import {
  REPLAY_WINDOW_SECONDS,
  signSlackRequest,
  verifySlackSignature,
} from "./signature";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const RAW_BODY = '{"type":"url_verification","challenge":"abc"}';
const NOW = new Date("2026-08-19T12:00:00Z");
const MILLISECONDS = 1000;

const timestampFor = (offsetSeconds: number): string =>
  String(Math.floor(NOW.getTime() / MILLISECONDS) + offsetSeconds);

const verify = async (headers: {
  signature?: string | null;
  timestamp?: string | null;
}) =>
  await verifySlackSignature({
    headers: {
      signature: headers.signature ?? null,
      timestamp: headers.timestamp ?? null,
    },
    now: NOW,
    rawBody: RAW_BODY,
    signingSecret: SIGNING_SECRET,
  });

describe("verifySlackSignature", () => {
  test("accepts a signature Slack would have produced", async () => {
    const timestamp = timestampFor(0);
    const signature = await signSlackRequest(
      SIGNING_SECRET,
      timestamp,
      RAW_BODY
    );

    expect(signature.startsWith("v0=")).toBe(true);
    expect(await verify({ signature, timestamp })).toEqual({ valid: true });
  });

  test("rejects a signature made with a different secret", async () => {
    const timestamp = timestampFor(0);
    const signature = await signSlackRequest(
      "other-secret",
      timestamp,
      RAW_BODY
    );

    expect(await verify({ signature, timestamp })).toEqual({
      reason: "invalid",
      valid: false,
    });
  });

  test("rejects a valid signature over a different body", async () => {
    const timestamp = timestampFor(0);
    const signature = await signSlackRequest(
      SIGNING_SECRET,
      timestamp,
      '{"type":"event_callback"}'
    );

    expect(await verify({ signature, timestamp })).toEqual({
      reason: "invalid",
      valid: false,
    });
  });

  test("rejects a replayed request outside the five minute window", async () => {
    const timestamp = timestampFor(-(REPLAY_WINDOW_SECONDS + 1));
    const signature = await signSlackRequest(
      SIGNING_SECRET,
      timestamp,
      RAW_BODY
    );

    // The signature itself is genuine - only the age makes it a replay.
    expect(await verify({ signature, timestamp })).toEqual({
      reason: "stale",
      valid: false,
    });
  });

  test("accepts a request at the edge of the window", async () => {
    const timestamp = timestampFor(-REPLAY_WINDOW_SECONDS);
    const signature = await signSlackRequest(
      SIGNING_SECRET,
      timestamp,
      RAW_BODY
    );

    expect(await verify({ signature, timestamp })).toEqual({ valid: true });
  });

  test("rejects missing or unparseable headers", async () => {
    expect(await verify({})).toEqual({ reason: "malformed", valid: false });
    expect(
      await verify({ signature: "v0=deadbeef", timestamp: "not-a-number" })
    ).toEqual({ reason: "malformed", valid: false });
  });
});
