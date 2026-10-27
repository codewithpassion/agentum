import { describe, expect, test } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { fromBase64Url, toBase64Url } from "../crypto.ts";
import { signViewToken, verifyViewToken } from "./view-token.ts";

const KEY = "view-key-not-a-real-secret-0123456789";
const OTHER_KEY = "a-different-view-key-0123456789";
const NOW = 1_800_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ARTIFACT_A = "0b6f4c2e-8a1d-4f3e-9c2b-7d5e1a2b3c4d";
const ARTIFACT_B = "5e2d9a14-3c7b-4f80-a6d1-2f9e8b7c6a50";

const claims = (overrides: Partial<ViewTokenClaims> = {}): ViewTokenClaims => ({
  artifactId: ARTIFACT_A,
  expiresAt: NOW + 600,
  userId: "user_1",
  versionId: "ver_1",
  viewer: "member",
  ...overrides,
});

const payloadOf = (token: string) =>
  token.slice("hm_view_".length).split(".")[0] ?? "";
const signatureOf = (token: string) => token.split(".")[1] ?? "";

/** A raw signed token for `payload`, skipping the schema to reach the checks after it. */
const signRaw = async (payload: string, key: string): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(payload)
  );
  return `hm_view_${payload}.${toBase64Url(new Uint8Array(mac))}`;
};

const encodeJson = (json: unknown) =>
  toBase64Url(encoder.encode(JSON.stringify(json)));

describe("signViewToken and verifyViewToken", () => {
  test.each(["member", "link", "test"] as const)(
    "round trips the claims for viewer %s",
    async (viewer) => {
      const input = claims({
        shareId: viewer === "link" ? "share_1" : undefined,
        userId: viewer === "member" ? "user_1" : undefined,
        viewer,
      });
      const token = await signViewToken(input, KEY);
      expect(token.startsWith("hm_view_")).toBe(true);
      expect(await verifyViewToken(token, KEY, NOW)).toEqual(input);
    }
  );

  test("rejects a tampered payload", async () => {
    const token = await signViewToken(claims(), KEY);
    const changed = JSON.parse(
      decoder.decode(fromBase64Url(payloadOf(token)) ?? new Uint8Array())
    ) as Record<string, unknown>;
    changed.expiresAt = NOW + 86_400;
    const forged = `hm_view_${toBase64Url(encoder.encode(JSON.stringify(changed)))}.${signatureOf(token)}`;
    expect(await verifyViewToken(forged, KEY, NOW)).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const token = await signViewToken(claims(), KEY);
    const signature = signatureOf(token);
    const first = signature[0] === "A" ? "B" : "A";
    const forged = `${token.slice(0, token.length - signature.length)}${first}${signature.slice(1)}`;
    expect(await verifyViewToken(forged, KEY, NOW)).toBeNull();
  });

  test("rejects a token signed with a different key", async () => {
    const token = await signViewToken(claims(), OTHER_KEY);
    expect(await verifyViewToken(token, KEY, NOW)).toBeNull();
  });

  test("rejects a payload swapped from artifact A to artifact B", async () => {
    const tokenA = await signViewToken(claims({ artifactId: ARTIFACT_A }), KEY);
    const tokenB = await signViewToken(claims({ artifactId: ARTIFACT_B }), KEY);
    const swapped = `hm_view_${payloadOf(tokenB)}.${signatureOf(tokenA)}`;
    expect(await verifyViewToken(swapped, KEY, NOW)).toBeNull();
  });

  test("returns null for a validly signed payload that fails the schema", async () => {
    const token = await signRaw(
      encodeJson({
        artifactId: "not-a-uuid",
        expiresAt: NOW + 60,
        versionId: "v",
        viewer: "member",
      }),
      KEY
    );
    expect(await verifyViewToken(token, KEY, NOW)).toBeNull();
  });

  test("returns null for a validly signed payload that is not JSON", async () => {
    const token = await signRaw(toBase64Url(encoder.encode("not json {")), KEY);
    expect(await verifyViewToken(token, KEY, NOW)).toBeNull();
  });

  test("returns null at and after expiry, and passes one second before", async () => {
    const token = await signViewToken(claims({ expiresAt: NOW }), KEY);
    expect(await verifyViewToken(token, KEY, NOW)).toBeNull();
    expect(await verifyViewToken(token, KEY, NOW + 1)).toBeNull();

    const live = await signViewToken(claims({ expiresAt: NOW }), KEY);
    expect(await verifyViewToken(live, KEY, NOW - 1)).not.toBeNull();
  });

  test.each([
    ["an empty string", ""],
    ["a wrong prefix", "hm_tok_abc.def"],
    ["the prefix alone", "hm_view_"],
    ["garbage", "garbage"],
    ["a missing signature", "hm_view_abc"],
    ["extra parts", "hm_view_a.b.c"],
    ["non base64url text", "hm_view_!!!.???"],
  ])("returns null for %s", async (_label, token) => {
    expect(await verifyViewToken(token, KEY, NOW)).toBeNull();
  });

  test("returns null for a valid token with its prefix changed", async () => {
    const token = await signViewToken(claims(), KEY);
    expect(
      await verifyViewToken(token.replace("hm_view_", "hm_tok_"), KEY, NOW)
    ).toBeNull();
  });

  test("the token does not contain the key", async () => {
    const token = await signViewToken(claims(), KEY);
    expect(token).not.toContain(KEY);
  });
});
