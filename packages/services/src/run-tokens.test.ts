import { beforeAll, beforeEach, expect, test } from "bun:test";
import { runs } from "@repo/db/schema/runs";
import { RUN_STATUSES, type RunStatus } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { isCryptoError } from "./crypto.ts";
import {
  importRunTokenKey,
  RUN_TOKEN_MAX_AGE_MS,
  RUN_TOKEN_PREFIX,
  type RunTokenClaims,
  signRunToken,
  verifyRunToken,
} from "./run-tokens.ts";

const keyBase64 = (fill: number) =>
  Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");

const HOUR_MS = 60 * 60 * 1000;
const CLAIMED_AT = new Date("2026-03-01T10:00:00.000Z");

const claimsFor = (
  overrides: Partial<RunTokenClaims> = {}
): RunTokenClaims => ({
  agentId: "agent_1",
  issuedAt: CLAIMED_AT.getTime(),
  runId: "run_1",
  workspaceId: "ws_1",
  ...overrides,
});

let db: ReturnType<typeof migrated>;
let key: CryptoKey;

beforeAll(async () => {
  key = await importRunTokenKey(keyBase64(1));
});

const insertRun = (
  id: string,
  status: RunStatus,
  leaseUntil: string | null,
  overrides: { agentId?: string; workspaceId?: string } = {}
) => {
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: overrides.agentId ?? "agent_1",
      createdAt: CLAIMED_AT.toISOString(),
      id,
      inputText: "hello",
      leaseUntil,
      sessionId: "s1",
      status,
      workspaceId: overrides.workspaceId ?? "ws_1",
    })
    .run();
};

const leaseAfter = (from: Date, ms: number) =>
  new Date(from.getTime() + ms).toISOString();

const verify = (token: string, now: Date, withKey = key) =>
  verifyRunToken({ db, key: withKey, now, token });

beforeEach(() => {
  db = migrated();
  insertRun("run_1", "running", leaseAfter(CLAIMED_AT, 5 * 60 * 1000));
});

test("a token minted at claim is accepted while the run is running on a live lease", async () => {
  const token = await signRunToken(key, claimsFor());
  expect(token.startsWith(RUN_TOKEN_PREFIX)).toBe(true);
  expect(await verify(token, CLAIMED_AT)).toEqual({
    claims: claimsFor(),
    ok: true,
  });
});

test("a token minted at claim is still accepted after three lease extensions", async () => {
  const token = await signRunToken(key, claimsFor());
  // The lease is about to pass; a heartbeat extends it, the token stays.
  const extendAndVerify = async (minutesAfterClaim: number) => {
    const now = new Date(CLAIMED_AT.getTime() + minutesAfterClaim * 60 * 1000);
    db.update(runs)
      .set({ leaseUntil: leaseAfter(now, 5 * 60 * 1000) })
      .where(eq(runs.id, "run_1"))
      .run();
    return (await verify(token, now)).ok;
  };
  expect(await extendAndVerify(4)).toBe(true);
  expect(await extendAndVerify(8)).toBe(true);
  expect(await extendAndVerify(12)).toBe(true);
});

test("a token for a run that is not running is refused", async () => {
  const lease = leaseAfter(CLAIMED_AT, 5 * 60 * 1000);
  const others = RUN_STATUSES.filter((status) => status !== "running");
  const results = await Promise.all(
    others.map(async (status) => {
      // A live lease does not help: the status alone refuses the token.
      insertRun(`run_${status}`, status, lease);
      const token = await signRunToken(
        key,
        claimsFor({ runId: `run_${status}` })
      );
      return await verify(token, CLAIMED_AT);
    })
  );
  expect(results).toEqual(
    others.map(() => ({ ok: false, reason: "not_running" }))
  );
});

test("a token for a running run whose lease has passed is refused", async () => {
  const token = await signRunToken(key, claimsFor());
  const leaseEnd = new Date(CLAIMED_AT.getTime() + 5 * 60 * 1000);
  expect((await verify(token, new Date(leaseEnd.getTime() - 1))).ok).toBe(true);
  // The lease ends at lease_until, so that instant is already too late.
  expect(await verify(token, leaseEnd)).toEqual({
    ok: false,
    reason: "not_running",
  });
  expect((await verify(token, new Date(leaseEnd.getTime() + 1000))).ok).toBe(
    false
  );
  db.update(runs).set({ leaseUntil: null }).where(eq(runs.id, "run_1")).run();
  expect((await verify(token, CLAIMED_AT)).ok).toBe(false);
});

test("a token older than 12 hours is refused even when the run is live", async () => {
  const token = await signRunToken(key, claimsFor());
  const edge = new Date(CLAIMED_AT.getTime() + RUN_TOKEN_MAX_AGE_MS);
  db.update(runs)
    .set({ leaseUntil: leaseAfter(edge, HOUR_MS) })
    .where(eq(runs.id, "run_1"))
    .run();
  expect((await verify(token, edge)).ok).toBe(true);
  expect(await verify(token, new Date(edge.getTime() + 1))).toEqual({
    ok: false,
    reason: "expired",
  });
});

test("a token issued in the future is refused", async () => {
  const token = await signRunToken(
    key,
    claimsFor({ issuedAt: CLAIMED_AT.getTime() + HOUR_MS })
  );
  expect(await verify(token, CLAIMED_AT)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("a tampered token is refused", async () => {
  insertRun("run_2", "running", leaseAfter(CLAIMED_AT, 5 * 60 * 1000));
  const token = await signRunToken(key, claimsFor());
  const other = await signRunToken(key, claimsFor({ runId: "run_2" }));
  const [signed = "", signature = ""] = token.split(".");
  const [, otherSignature = ""] = other.split(".");
  const otherPayload = other.split(".")[0] ?? "";

  const flippedSignature = Buffer.from(signature, "base64url");
  flippedSignature[0] = ((flippedSignature[0] ?? 0) + 1) % 256;

  const tampered = [
    // Another valid payload under this token's signature.
    `${otherPayload}.${signature}`,
    // This payload under another token's signature.
    `${signed}.${otherSignature}`,
    // One changed signature byte, and a dropped signature.
    `${signed}.${flippedSignature.toString("base64url")}`,
    `${signed}.`,
    signed,
    // Not a run token at all.
    `hm_other_${signed.slice(RUN_TOKEN_PREFIX.length)}.${signature}`,
    token.replace(RUN_TOKEN_PREFIX, ""),
    `${token}.extra`,
    "hm_run_.",
    "hm_run_not base64!.also not",
    "",
  ];
  const results = await Promise.all(
    tampered.map((text) => verify(text, CLAIMED_AT))
  );
  expect(results).toEqual(
    tampered.map(() => ({ ok: false, reason: "invalid" }))
  );
  expect((await verify(token, CLAIMED_AT)).ok).toBe(true);
});

test("a token signed under another key is refused", async () => {
  const token = await signRunToken(
    await importRunTokenKey(keyBase64(2)),
    claimsFor()
  );
  expect(await verify(token, CLAIMED_AT)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("a token is refused when its run belongs to another workspace or agent", async () => {
  const otherWorkspace = await signRunToken(
    key,
    claimsFor({ workspaceId: "ws_2" })
  );
  const otherAgent = await signRunToken(key, claimsFor({ agentId: "agent_2" }));
  const unknownRun = await signRunToken(key, claimsFor({ runId: "run_9" }));
  const results = await Promise.all(
    [otherWorkspace, otherAgent, unknownRun].map((token) =>
      verify(token, CLAIMED_AT)
    )
  );
  expect(results).toEqual([
    { ok: false, reason: "not_running" },
    { ok: false, reason: "not_running" },
    { ok: false, reason: "not_running" },
  ]);
});

test("a signed payload with the wrong shape is refused", async () => {
  const payload = Buffer.from(JSON.stringify({ runId: "run_1" })).toString(
    "base64url"
  );
  const signed = `${RUN_TOKEN_PREFIX}${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signed)
  );
  const token = `${signed}.${Buffer.from(signature).toString("base64url")}`;
  expect(await verify(token, CLAIMED_AT)).toEqual({
    ok: false,
    reason: "invalid",
  });
});

test("the key must be exactly 32 bytes of base64 and is not extractable", async () => {
  const bad = [
    Buffer.from(new Uint8Array(16)).toString("base64"),
    Buffer.from(new Uint8Array(33)).toString("base64"),
    "not base64 at all!",
    "",
  ];
  const failures = await Promise.all(
    bad.map((text) => importRunTokenKey(text).catch((e: unknown) => e))
  );
  expect(failures.map(isCryptoError)).toEqual(bad.map(() => true));
  expect(key.extractable).toBe(false);
});
