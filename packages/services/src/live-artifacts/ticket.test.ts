import { describe, expect, test } from "bun:test";
import type { RoomTicketClaims } from "@repo/protocol/live";
import { signRoomTicket, verifyRoomTicket } from "./ticket.ts";

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
const expected = {
  artifactId: claims.artifactId,
  nowSeconds: 110,
  workspaceId: claims.workspaceId,
};
describe("room tickets", () => {
  test("binds signed claims to a room and time", async () => {
    const ticket = await signRoomTicket(claims, "test key");
    expect(await verifyRoomTicket(ticket, "test key", expected)).toEqual(
      claims
    );
    expect(await verifyRoomTicket(ticket, "wrong key", expected)).toBeNull();
    expect(
      await verifyRoomTicket(`${ticket}x`, "test key", expected)
    ).toBeNull();
    expect(
      await verifyRoomTicket(ticket, "test key", {
        ...expected,
        nowSeconds: 220,
      })
    ).toBeNull();
    expect(
      await verifyRoomTicket(ticket, "test key", {
        ...expected,
        nowSeconds: 99,
      })
    ).toBeNull();
    expect(
      await verifyRoomTicket(ticket, "test key", {
        ...expected,
        workspaceId: "other",
      })
    ).toBeNull();
    expect(
      await verifyRoomTicket(ticket, "test key", {
        ...expected,
        artifactId: "other",
      })
    ).toBeNull();
    expect(
      await verifyRoomTicket("hm_room_bad.bad", "test key", expected)
    ).toBeNull();
  });
  test("refuses invalid claims when signing", async () => {
    await expect(
      signRoomTicket({ ...claims, color: "red" }, "test key")
    ).rejects.toThrow();
  });
});
