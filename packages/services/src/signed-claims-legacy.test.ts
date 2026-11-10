/**
 * Tokens minted by the code before `signClaims`, rebuilt here from the old
 * formats, must verify with the new helpers, and the new signers must mint the
 * same bytes. Live tokens depend on it.
 */
import { expect, test } from "bun:test";
import type { RoomTicketClaims } from "@repo/protocol/live";
import { ARTIFACT_VIEW_TOKEN, RUN_TOKEN } from "@repo/protocol/token-prefixes";
import { signViewToken, verifyViewToken } from "./artifacts/view-token.ts";
import { sha256Hex } from "./crypto.ts";
import { signRoomTicket, verifyRoomTicket } from "./live-artifacts/ticket.ts";
import {
  importRunTokenKey,
  signRunToken,
  verifyRunToken,
} from "./run-tokens.ts";

const encoder = new TextEncoder();
const HMAC = { hash: "SHA-256", name: "HMAC" } as const;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const macOf = async (rawKey: Uint8Array, signed: string) => {
  const key = await crypto.subtle.importKey("raw", rawKey, HMAC, false, [
    "sign",
  ]);
  return b64url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(signed))
    )
  );
};

/** The old view token and room ticket: the MAC covers the payload alone. */
const legacyPayloadMac = async (
  prefix: string,
  claims: unknown,
  textKey: string
) => {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  return `${prefix}${payload}.${await macOf(encoder.encode(textKey), payload)}`;
};

test("view token: the old token verifies, and the new one is the same bytes", async () => {
  const claims = {
    artifactId: "0b6f4c2e-8a1d-4f3e-9c2b-7d5e1a2b3c4d",
    expiresAt: 1_800_000_600,
    userId: "user_1",
    versionId: "ver_1",
    viewer: "member",
    workspaceId: "ws_1",
  } as const;
  const old = await legacyPayloadMac(
    ARTIFACT_VIEW_TOKEN.issue,
    claims,
    "k-view"
  );
  expect(await verifyViewToken(old, "k-view", 1_800_000_000)).toEqual(claims);
  expect(await signViewToken(claims, "k-view")).toBe(old);
  const renamed = old.replace(ARTIFACT_VIEW_TOKEN.issue, "hm_view_");
  expect(await verifyViewToken(renamed, "k-view", 1_800_000_000)).toEqual(
    claims
  );
});

test("room ticket: the old token verifies, and the new one is the same bytes", async () => {
  const claims: RoomTicketClaims = {
    artifactId: "aa7d3b9a-71ca-4d2a-b938-8ad4ad348e3b",
    audience: "artifact-room",
    color: "#aabbcc",
    connectionExpiresAt: 1000,
    expiresAt: 220,
    issuedAt: 100,
    jti: "nonce",
    kind: "member",
    name: "A",
    participantId: "user",
    role: "editor",
    version: 1,
    workspaceId: "workspace",
  };
  const prefix = (await signRoomTicket(claims, "k-room"))
    .split("_")
    .slice(0, 2)
    .join("_");
  const old = await legacyPayloadMac(`${prefix}_`, claims, "k-room");
  const expected = {
    artifactId: claims.artifactId,
    nowSeconds: 110,
    workspaceId: claims.workspaceId,
  };
  expect(await verifyRoomTicket(old, "k-room", expected)).toEqual(claims);
  expect(await signRoomTicket(claims, "k-room")).toBe(old);
});

test("run token: the old token verifies, and the new one is the same bytes", async () => {
  const raw = new Uint8Array(32).fill(7);
  const spec = Buffer.from(raw).toString("base64");
  const key = await importRunTokenKey(spec);
  const fields = ["run_1", "agent_1", "ws_1", 1_800_000_000_000];
  const verifyOld = async (prefix: string) => {
    const payload = b64url(encoder.encode(JSON.stringify(fields)));
    const old = `${prefix}${payload}.${await macOf(raw, `${prefix}${payload}`)}`;
    // Past the 12 hour limit: only a genuine signature gets as far as "expired".
    return await verifyRunToken({
      db: {} as never,
      key,
      now: new Date(1_800_000_000_000 + 13 * 60 * 60 * 1000),
      token: old,
    });
  };
  const expired = { ok: false, reason: "expired" } as const;
  expect(await verifyOld("ag_run_")).toEqual(expired);
  expect(await verifyOld("hm_run_")).toEqual(expired);
  const minted = await signRunToken(key, {
    agentId: "agent_1",
    issuedAt: 1_800_000_000_000,
    runId: "run_1",
    workspaceId: "ws_1",
  });
  const payload = b64url(encoder.encode(JSON.stringify(fields)));
  expect(minted).toBe(
    `${RUN_TOKEN.issue}${payload}.${await macOf(raw, `${RUN_TOKEN.issue}${payload}`)}`
  );
});

test("sha256Hex: SHA-256 of the UTF-8 text, lowercase hex", async () => {
  expect(await sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});
