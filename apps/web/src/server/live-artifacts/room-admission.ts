/** One-shot hand-off from the room route to the room. The route verifies the
 * member once (Clerk, membership, session) and signs what it found, so the room
 * does not run the same Clerk check again. The assertion is bound to one room,
 * one ticket id and a short lifetime. The room still verifies the ticket,
 * consumes its id and re-reads access, so a replayed or forged assertion buys
 * nothing: a valid ticket id is single use. */

import { ROOM_ADMISSION } from "@repo/protocol/token-prefixes";
import {
  constantTimeEqual,
  fromBase64Url,
  toBase64Url,
} from "@repo/services/crypto";
import { verifyRoomTicket } from "@repo/services/live-artifacts/ticket";
import type { Principal, WorkspacePrincipal } from "@repo/services/workspaces";

/** The room ticket's signing key. Empty when the Worker has no view key. */
export const roomTicketKey = (env: Env) =>
  env.ARTIFACT_VIEW_KEY ? `artifact-room:${env.ARTIFACT_VIEW_KEY}` : "";

export const ADMISSION_HEADER = "X-Hm-Room-Admission";
/** Longer than a slow admission needs, far shorter than a ticket. */
export const ADMISSION_SECONDS = 30;
/** The route and the room run in different isolates. */
const CLOCK_SKEW_SECONDS = 2;

const HMAC = { hash: "SHA-256", name: "HMAC" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RoomAdmission {
  artifactId: string;
  expiresAt: number;
  issuedAt: number;
  jti: string;
  principal: WorkspacePrincipal;
  /** The Clerk session the route verified, for a cookie sign-in. */
  sessionId?: string;
  workspaceId: string;
}

/** A separate key string from the ticket MAC, so a ticket never verifies as an assertion. */
const mac = async (key: string, payload: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      HMAC.name,
      await crypto.subtle.importKey(
        "raw",
        encoder.encode(`room-admission:${key}`),
        HMAC,
        false,
        ["sign"]
      ),
      encoder.encode(payload)
    )
  );

export const signRoomAdmission = async (
  admission: RoomAdmission,
  key: string
): Promise<string> => {
  const payload = toBase64Url(encoder.encode(JSON.stringify(admission)));
  return `${ROOM_ADMISSION.issue}${payload}.${toBase64Url(await mac(key, payload))}`;
};

const isAdmission = (value: unknown): value is RoomAdmission => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const p = v.principal as Record<string, unknown> | null | undefined;
  return (
    typeof v.artifactId === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.jti === "string" &&
    typeof v.issuedAt === "number" &&
    typeof v.expiresAt === "number" &&
    (v.sessionId === undefined || typeof v.sessionId === "string") &&
    typeof p === "object" &&
    p !== null &&
    typeof p.kind === "string" &&
    p.kind !== "system" &&
    p.workspaceId === v.workspaceId
  );
};

/** Null for anything but a fresh assertion for exactly this room and ticket id. */
export const verifyRoomAdmission = async (
  header: string,
  key: string,
  expected: { artifactId: string; jti: string; workspaceId: string },
  nowSeconds: number
): Promise<RoomAdmission | null> => {
  const body = ROOM_ADMISSION.strip(header);
  if (!key || body === null || header.length > 8192) {
    return null;
  }
  const parts = body.split(".");
  const [payload, signatureText] = parts;
  if (parts.length !== 2 || !payload || !signatureText) {
    return null;
  }
  const signature = fromBase64Url(signatureText);
  if (!(signature && constantTimeEqual(await mac(key, payload), signature))) {
    return null;
  }
  const bytes = fromBase64Url(payload);
  if (!bytes) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (
      !isAdmission(parsed) ||
      parsed.artifactId !== expected.artifactId ||
      parsed.workspaceId !== expected.workspaceId ||
      parsed.jti !== expected.jti ||
      parsed.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
      parsed.expiresAt <= nowSeconds ||
      parsed.expiresAt - parsed.issuedAt > ADMISSION_SECONDS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export type RequestAdmission =
  | { status: "absent" }
  | { status: "refused" }
  | { status: "trusted"; admission: RoomAdmission };

/** What the room makes of a request's assertion. `absent` means the request did
 * not come through the route, so the caller authenticates it in full. A header
 * that is present but wrong is refused, never downgraded to a full check. */
export const admissionFromRequest = async (
  request: Request,
  ticket: string,
  key: string,
  scope: { artifactId: string; workspaceId: string },
  nowSeconds: number
): Promise<RequestAdmission> => {
  const header = request.headers.get(ADMISSION_HEADER);
  if (header === null) {
    return { status: "absent" };
  }
  const claims = await verifyRoomTicket(ticket, key, { ...scope, nowSeconds });
  const admission = claims
    ? await verifyRoomAdmission(
        header,
        key,
        { ...scope, jti: claims.jti },
        nowSeconds
      )
    : null;
  return admission ? { admission, status: "trusted" } : { status: "refused" };
};

/** The member behind a room request. A request the route signed carries its
 * verified result, so `authenticate` (Clerk) does not run again. A request with
 * no assertion is authenticated in full, and a wrong assertion is refused. */
export interface RoomMember {
  principal: Principal;
  sessionId?: string;
  /** Set when the route already verified this principal for this admission. */
  verified?: Principal;
}
export const requestMember = async (
  authenticate: () => Promise<RoomMember | null>,
  bound: {
    key: string;
    scope: { artifactId: string; workspaceId: string };
    ticket: string;
  },
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<RoomMember | null> => {
  const trusted = await admissionFromRequest(
    request,
    bound.ticket,
    bound.key,
    bound.scope,
    nowSeconds
  );
  if (trusted.status === "refused") {
    return null;
  }
  if (trusted.status === "trusted") {
    const { principal, sessionId } = trusted.admission;
    return { principal, sessionId, verified: principal };
  }
  return authenticate();
};
