/** Signed, short-lived room credentials. Replay consumption belongs to the room. */
import {
  type RoomTicketClaims,
  roomTicketClaimsSchema,
} from "@repo/protocol/live";
import { constantTimeEqual, fromBase64Url, toBase64Url } from "../crypto.ts";

const PREFIX = "hm_room_";
const HMAC = { hash: "SHA-256", name: "HMAC" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const mac = async (key: string, payload: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    HMAC,
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(HMAC.name, imported, encoder.encode(payload))
  );
};

export const signRoomTicket = async (
  claims: RoomTicketClaims,
  key: string
): Promise<string> => {
  const payload = toBase64Url(
    encoder.encode(JSON.stringify(roomTicketClaimsSchema.parse(claims)))
  );
  return `${PREFIX}${payload}.${toBase64Url(await mac(key, payload))}`;
};

/** Verifies the signature and room binding; callers must atomically consume jti. */
export const verifyRoomTicket = async (
  token: string,
  key: string,
  expected: { artifactId: string; workspaceId: string; nowSeconds: number }
): Promise<RoomTicketClaims | null> => {
  if (!token.startsWith(PREFIX)) {
    return null;
  }
  const parts = token.slice(PREFIX.length).split(".");
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
    const parsed = roomTicketClaimsSchema.safeParse(
      JSON.parse(decoder.decode(bytes))
    );
    if (!parsed.success) {
      return null;
    }
    const claims = parsed.data;
    if (
      claims.artifactId !== expected.artifactId ||
      claims.workspaceId !== expected.workspaceId ||
      claims.issuedAt > expected.nowSeconds ||
      claims.expiresAt <= expected.nowSeconds ||
      claims.connectionExpiresAt <= expected.nowSeconds
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};
