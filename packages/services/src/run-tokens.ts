/**
 * Run tokens (contract C6): `hm_run_<payload>.<signature>`, one per run, used
 * by the agent for the whole run. The payload is base64url JSON
 * `[runId, agentId, workspaceId, issuedAtMs]`; the signature is HMAC-SHA256
 * over `hm_run_<payload>` under `RUN_TOKEN_KEY` (32 random bytes, base64).
 *
 * The token alone proves who minted it, not that it is still good. A token is
 * valid on use when all of these hold: the signature checks, it is at most 12
 * hours old, and its run row is `running` with `lease_until` in the future.
 * The token carries no lease, so heartbeats that extend the lease never need a
 * new token. `verifyRunToken` runs all three checks.
 *
 * Pure Web Crypto, so it runs in workerd and in bun alike.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { CryptoError, fromBase64Url, toBase64Url } from "./crypto.ts";

export const RUN_TOKEN_PREFIX = "hm_run_";
export const RUN_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** How far ahead of `now` an issue time may be, for clock drift between Workers. */
const CLOCK_SKEW_MS = 60_000;
const KEY_BYTES = 32;
const ALGORITHM = { hash: "SHA-256", name: "HMAC" } as const;
const INVALID_KEY = "RUN_TOKEN_KEY must be 32 random bytes, base64 encoded.";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const payloadSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
  z.number().int(),
]);

export interface RunTokenClaims {
  agentId: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  runId: string;
  workspaceId: string;
}

/**
 * Why a token was refused. The reason is for logs and tests, not for the
 * caller of the API: answer every refusal with the same 401.
 */
export type RunTokenRefusal = "expired" | "invalid" | "not_running";

export type RunTokenResult =
  | { claims: RunTokenClaims; ok: true }
  | { ok: false; reason: RunTokenRefusal };

/** The HMAC key from `RUN_TOKEN_KEY` (standard base64 of 32 bytes). */
export const importRunTokenKey = async (base64: string): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
  } catch (error: unknown) {
    throw new CryptoError(INVALID_KEY, { cause: error });
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new CryptoError(INVALID_KEY);
  }
  return await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
    "sign",
    "verify",
  ]);
};

/** A token for `claims`. Mint it once, when the run is claimed. */
export const signRunToken = async (
  key: CryptoKey,
  claims: RunTokenClaims
): Promise<string> => {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify([
        claims.runId,
        claims.agentId,
        claims.workspaceId,
        claims.issuedAt,
      ])
    )
  );
  const signed = `${RUN_TOKEN_PREFIX}${payload}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    key,
    encoder.encode(signed)
  );
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`;
};

/** The claims of a token whose signature checks, else null. */
const openToken = async (
  key: CryptoKey,
  token: string
): Promise<RunTokenClaims | null> => {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) {
    return null;
  }
  const parts = token.split(".");
  const [signed, signatureText] = parts;
  if (parts.length !== 2 || !signed || !signatureText) {
    return null;
  }
  const signature = fromBase64Url(signatureText);
  const payload = fromBase64Url(signed.slice(RUN_TOKEN_PREFIX.length));
  if (!(signature && payload)) {
    return null;
  }
  // subtle.verify compares in constant time.
  const genuine = await crypto.subtle.verify(
    ALGORITHM.name,
    key,
    signature,
    encoder.encode(signed)
  );
  if (!genuine) {
    return null;
  }
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(decoder.decode(payload)));
    if (!parsed.success) {
      return null;
    }
    const [runId, agentId, workspaceId, issuedAt] = parsed.data;
    return { agentId, issuedAt, runId, workspaceId };
  } catch {
    return null;
  }
};

/**
 * Whether `token` may act now: genuine, at most 12 hours old, and its run is
 * `running` with a lease that has not passed (`lease_until` is ISO 8601 UTC,
 * so text comparison orders it correctly). The run row must match the token's
 * workspace and agent too.
 */
export const verifyRunToken = async ({
  db,
  key,
  now = new Date(),
  token,
}: {
  db: Database;
  key: CryptoKey;
  now?: Date;
  token: string;
}): Promise<RunTokenResult> => {
  const claims = await openToken(key, token);
  if (!claims) {
    return { ok: false, reason: "invalid" };
  }
  const age = now.getTime() - claims.issuedAt;
  if (age < -CLOCK_SKEW_MS) {
    return { ok: false, reason: "invalid" };
  }
  if (age > RUN_TOKEN_MAX_AGE_MS) {
    return { ok: false, reason: "expired" };
  }
  const live = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, claims.runId),
        eq(runs.workspaceId, claims.workspaceId),
        eq(runs.agentId, claims.agentId),
        eq(runs.status, "running"),
        gt(runs.leaseUntil, now.toISOString())
      )
    )
    .limit(1);
  return live.length > 0
    ? { claims, ok: true }
    : { ok: false, reason: "not_running" };
};
