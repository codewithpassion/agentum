/** Signed, short-lived room credentials. Replay consumption belongs to the room. */
import {
  type RoomTicketClaims,
  roomTicketClaimsSchema,
} from "@repo/protocol/live";
import { ROOM_TICKET } from "@repo/protocol/token-prefixes";
import { hmacKeyFromText, openClaims, signClaims } from "../crypto.ts";

export const signRoomTicket = async (
  claims: RoomTicketClaims,
  key: string
): Promise<string> =>
  signClaims(
    await hmacKeyFromText(key),
    ROOM_TICKET,
    roomTicketClaimsSchema.parse(claims)
  );

/** Verifies the signature and room binding; callers must atomically consume jti. */
export const verifyRoomTicket = async (
  token: string,
  key: string,
  expected: { artifactId: string; workspaceId: string; nowSeconds: number }
): Promise<RoomTicketClaims | null> => {
  const parsed = roomTicketClaimsSchema.safeParse(
    await openClaims([await hmacKeyFromText(key)], ROOM_TICKET, token)
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
};
