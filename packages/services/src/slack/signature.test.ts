import { expect, test } from "bun:test";
import { signSlackBody, verifySlackRequest } from "./signature.ts";

const HEX_SIGNATURE = /^v0=[0-9a-f]{64}$/;
const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY =
  "payload=%7B%22type%22%3A%22block_actions%22%7D&token=xyzz0WbapA4vBCDEFasx0q6G";
/** 2026-09-08T00:00:00Z, in seconds, as Slack sends it. */
const TIMESTAMP = "1789171200";
const NOW = Number(TIMESTAMP) * 1000;

/**
 * Slack's v0 scheme, written out independently of the implementation, so the
 * vector below is a fact about HMAC-SHA256 and not a copy of our own code.
 */
async function slackSignature(
  secret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

test("signSlackBody matches the independent v0 signature", async () => {
  expect(
    await signSlackBody({
      body: BODY,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY));
});

test("a request signed with the secret over v0:timestamp:body is accepted", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  expect(signature).toMatch(HEX_SIGNATURE);
  expect(
    await verifySlackRequest({
      body: BODY,
      now: NOW,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(true);
});

test("a signature made with another secret is refused", async () => {
  const signature = await slackSignature("not-the-secret", TIMESTAMP, BODY);
  expect(
    await verifySlackRequest({
      body: BODY,
      now: NOW,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(false);
});

test("a body changed after signing is refused", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  expect(
    await verifySlackRequest({
      body: `${BODY}&extra=1`,
      now: NOW,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(false);
});

test("a signature replayed under another timestamp is refused", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  const later = String(Number(TIMESTAMP) + 1);
  expect(
    await verifySlackRequest({
      body: BODY,
      now: NOW,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: later,
    })
  ).toBe(false);
});

test("a correctly signed request older than five minutes is refused", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  const input = {
    body: BODY,
    signature,
    signingSecret: SIGNING_SECRET,
    timestamp: TIMESTAMP,
  };
  expect(await verifySlackRequest({ ...input, now: NOW + 299_000 })).toBe(true);
  expect(await verifySlackRequest({ ...input, now: NOW + 301_000 })).toBe(
    false
  );
});

test("a timestamp far in the future is refused too", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  expect(
    await verifySlackRequest({
      body: BODY,
      now: NOW - 301_000,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(false);
});

test("malformed headers are refused without a comparison", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
  const base = {
    body: BODY,
    now: NOW,
    signingSecret: SIGNING_SECRET,
    timestamp: TIMESTAMP,
  };
  expect(await verifySlackRequest({ ...base, signature: "" })).toBe(false);
  expect(await verifySlackRequest({ ...base, signature: "v0=nothex" })).toBe(
    false
  );
  expect(
    await verifySlackRequest({ ...base, signature: signature.toUpperCase() })
  ).toBe(false);
  expect(
    await verifySlackRequest({ ...base, signature: signature.slice(0, -2) })
  ).toBe(false);
  expect(
    await verifySlackRequest({ ...base, signature, timestamp: "not-a-number" })
  ).toBe(false);
  expect(await verifySlackRequest({ ...base, signature, timestamp: "" })).toBe(
    false
  );
});

test("an empty body still verifies", async () => {
  const signature = await slackSignature(SIGNING_SECRET, TIMESTAMP, "");
  expect(
    await verifySlackRequest({
      body: "",
      now: NOW,
      signature,
      signingSecret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    })
  ).toBe(true);
});
