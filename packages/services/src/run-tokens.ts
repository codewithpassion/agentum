/**
 * Run tokens (contract C6): `hm_run_<payload>.<signature>`, one per run, used
 * by the agent for the whole run. The payload is base64url JSON
 * `[runId, agentId, workspaceId, issuedAtMs]`; the signature is HMAC-SHA256
 * over `hm_run_<payload>` under `RUN_TOKEN_KEY` (32 random bytes, base64).
 *
 * The token alone proves who minted it, not that it is still good. A token is
 * valid on use when all of these hold: the signature checks, it is at most 12
 * hours old, and its run row is `running` or `waiting` with `lease_until` in
 * the future.
 * The token carries no lease, so heartbeats that extend the lease never need a
 * new token. `verifyRunToken` runs all three checks.
 *
 * Pure Web Crypto, so it runs in workerd and in bun alike.
 */
import type { Database } from "@repo/db";
import { managedSessions } from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { CryptoError, fromBase64Url, toBase64Url } from "./crypto.ts";
import { MANAGED_CLAIMER } from "./managed/types.ts";

export const RUN_TOKEN_PREFIX = "hm_run_";
/**
 * `hm_ses_<payload>.<signature>`: one token per managed session, signed like a
 * run token over `[sessionId, agentId, workspaceId, issuedAtMs]`. A managed
 * agent's MCP servers are fixed when the Anthropic agent is registered, so a
 * run cannot hand it a token. The token rides in the session's own vault
 * instead, and each request resolves to the session's `running` or `waiting`
 * run. It has
 * no age limit: the `managed_sessions` row says whether it is still good.
 */
export const SESSION_TOKEN_PREFIX = "hm_ses_";
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

const signFields = async (
  key: CryptoKey,
  prefix: string,
  fields: readonly [string, string, string, number]
): Promise<string> => {
  const payload = toBase64Url(encoder.encode(JSON.stringify(fields)));
  const signed = `${prefix}${payload}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    key,
    encoder.encode(signed)
  );
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`;
};

/** A token for `claims`. Mint it once, when the run is claimed. */
export const signRunToken = (
  key: CryptoKey,
  claims: RunTokenClaims
): Promise<string> =>
  signFields(key, RUN_TOKEN_PREFIX, [
    claims.runId,
    claims.agentId,
    claims.workspaceId,
    claims.issuedAt,
  ]);

export interface SessionTokenClaims {
  agentId: string;
  /** Epoch milliseconds. The `managed_sessions` row holds the one that counts. */
  issuedAt: number;
  sessionId: string;
  workspaceId: string;
}

/** A token for a managed session. Mint it when its Anthropic session is made. */
export const signSessionToken = (
  key: CryptoKey,
  claims: SessionTokenClaims
): Promise<string> =>
  signFields(key, SESSION_TOKEN_PREFIX, [
    claims.sessionId,
    claims.agentId,
    claims.workspaceId,
    claims.issuedAt,
  ]);

/** The payload of a token whose prefix and signature check, else null. */
const openFields = async (
  key: CryptoKey,
  prefix: string,
  token: string
): Promise<z.infer<typeof payloadSchema> | null> => {
  if (!token.startsWith(prefix)) {
    return null;
  }
  const parts = token.split(".");
  const [signed, signatureText] = parts;
  if (parts.length !== 2 || !signed || !signatureText) {
    return null;
  }
  const signature = fromBase64Url(signatureText);
  const payload = fromBase64Url(signed.slice(prefix.length));
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
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The claims of a run token whose signature checks, else null. */
const openToken = async (
  key: CryptoKey,
  token: string
): Promise<RunTokenClaims | null> => {
  const fields = await openFields(key, RUN_TOKEN_PREFIX, token);
  if (!fields) {
    return null;
  }
  const [runId, agentId, workspaceId, issuedAt] = fields;
  return { agentId, issuedAt, runId, workspaceId };
};

/**
 * Whether `token` may act now: genuine, at most 12 hours old, and its run is
 * `running` or `waiting` with a lease that has not passed (`lease_until` is
 * ISO 8601 UTC, so text comparison orders it correctly). The run row must
 * match the token's workspace and agent too.
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
        inArray(runs.status, ["running", "waiting"]),
        gt(runs.leaseUntil, now.toISOString())
      )
    )
    .limit(1);
  return live.length > 0
    ? { claims, ok: true }
    : { ok: false, reason: "not_running" };
};

/**
 * Whether a session token may act now, and as which run. The signature checks,
 * the session's `managed_sessions` row is open and was made for exactly this
 * token (a newer session replaces it), and the run the session is serving
 * (`current_run_id`, set before its message is sent) is `running` or `waiting`
 * with a live lease. A run that is merely claimed, or an older run of the session whose
 * Anthropic session lingers, resolves to nothing. The claims are that run's, so everything downstream of a
 * run token (the platform MCP, the connector proxy, credentials) works on
 * them unchanged, and a session whose next run is for another person resolves
 * that person's credentials.
 */
export const verifySessionToken = async ({
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
  const fields = await openFields(key, SESSION_TOKEN_PREFIX, token);
  if (!fields) {
    return { ok: false, reason: "invalid" };
  }
  const [sessionId, agentId, workspaceId, issuedAt] = fields;
  if (issuedAt - now.getTime() > CLOCK_SKEW_MS) {
    return { ok: false, reason: "invalid" };
  }
  const [open] = await db
    .select({ currentRunId: managedSessions.currentRunId })
    .from(managedSessions)
    .innerJoin(sessions, eq(sessions.id, managedSessions.sessionId))
    .where(
      and(
        eq(managedSessions.sessionId, sessionId),
        eq(managedSessions.workspaceId, workspaceId),
        eq(managedSessions.tokenIssuedAt, issuedAt),
        isNull(managedSessions.closedAt),
        eq(sessions.agentId, agentId)
      )
    )
    .limit(1);
  if (!open?.currentRunId) {
    return { ok: false, reason: "invalid" };
  }
  const [live] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, open.currentRunId),
        eq(runs.sessionId, sessionId),
        eq(runs.workspaceId, workspaceId),
        eq(runs.agentId, agentId),
        eq(runs.claimedBy, MANAGED_CLAIMER),
        inArray(runs.status, ["running", "waiting"]),
        gt(runs.leaseUntil, now.toISOString())
      )
    )
    .limit(1);
  return live
    ? { claims: { agentId, issuedAt, runId: live.id, workspaceId }, ok: true }
    : { ok: false, reason: "not_running" };
};

/** `verifyRunToken` or `verifySessionToken`, by the token's prefix. */
export const verifyAgentToken = (args: {
  db: Database;
  key: CryptoKey;
  now?: Date;
  token: string;
}): Promise<RunTokenResult> =>
  args.token.startsWith(SESSION_TOKEN_PREFIX)
    ? verifySessionToken(args)
    : verifyRunToken(args);
