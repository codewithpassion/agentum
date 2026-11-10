import { expect, test } from "bun:test";
import { roomTicketClaimsSchema } from "@repo/protocol/live";
import { signRoomTicket } from "@repo/services/live-artifacts/ticket";
import {
  ADMISSION_HEADER,
  admissionFromRequest,
  type RoomAdmission,
  requestMember,
  signRoomAdmission,
  verifyRoomAdmission,
} from "./room-admission";

const key = "artifact-room:view-key";
const artifactId = crypto.randomUUID();
const scope = { artifactId, workspaceId: "w1" };
const now = 1_800_000_000;
const principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
const admission = (over: Partial<RoomAdmission> = {}): RoomAdmission => ({
  artifactId,
  expiresAt: now + 30,
  issuedAt: now,
  jti: "j1",
  principal,
  sessionId: "sess_1",
  workspaceId: "w1",
  ...over,
});
const verify = async (header: string, over = {}, at = now) =>
  verifyRoomAdmission(header, key, { ...scope, jti: "j1", ...over }, at);

test("a fresh assertion for this room and ticket id verifies", async () => {
  const got = await verify(await signRoomAdmission(admission(), key));
  expect(got?.principal).toEqual(principal);
  expect(got?.sessionId).toBe("sess_1");
});

test("assertions are signed as ag_adm_, and a pre-rename hm_adm_ one still verifies", async () => {
  const good = await signRoomAdmission(admission(), key);
  expect(good).toStartWith("ag_adm_");
  expect((await verify(good.replace("ag_adm_", "hm_adm_")))?.principal).toEqual(
    principal
  );
  expect(await verify(good.replace("ag_adm_", "xx_adm_"))).toBeNull();
});

test("forged, tampered and wrong-key assertions are refused", async () => {
  const good = await signRoomAdmission(admission(), key);
  expect(
    await verify(await signRoomAdmission(admission(), "other"))
  ).toBeNull();
  const [payload, signature] = good.slice("hm_adm_".length).split(".");
  const swapped = btoa(
    JSON.stringify(
      admission({ principal: { ...principal, isAdmin: true, userId: "u2" } })
    )
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  expect(await verify(`hm_adm_${swapped}.${signature}`)).toBeNull();
  expect(await verify(`hm_adm_${payload}.AAAA`)).toBeNull();
  expect(await verify("hm_adm_x")).toBeNull();
  expect(await verify("")).toBeNull();
  expect(
    await verifyRoomAdmission(good, "", { ...scope, jti: "j1" }, now)
  ).toBeNull();
});

test("expired, future-dated and over-long assertions are refused", async () => {
  const header = await signRoomAdmission(admission(), key);
  expect(await verify(header, {}, now + 30)).toBeNull();
  expect(await verify(header, {}, now - 3)).toBeNull();
  const long = await signRoomAdmission(
    admission({ expiresAt: now + 3600 }),
    key
  );
  expect(await verify(long)).toBeNull();
});

test("an assertion is bound to its room and ticket id", async () => {
  const header = await signRoomAdmission(admission(), key);
  expect(await verify(header, { artifactId: crypto.randomUUID() })).toBeNull();
  expect(await verify(header, { workspaceId: "w2" })).toBeNull();
  expect(await verify(header, { jti: "j2" })).toBeNull();
});

test("a system principal or a principal from another workspace is refused", async () => {
  const system = await signRoomAdmission(
    admission({ principal: { kind: "system" } as never }),
    key
  );
  expect(await verify(system)).toBeNull();
  const other = await signRoomAdmission(
    admission({ principal: { ...principal, workspaceId: "w2" } }),
    key
  );
  expect(await verify(other)).toBeNull();
});

test("a room ticket never verifies as an assertion", async () => {
  const ticket = await signRoomTicket(
    roomTicketClaimsSchema.parse({
      artifactId,
      audience: "artifact-room",
      color: "#059669",
      connectionExpiresAt: now + 120,
      expiresAt: now + 60,
      issuedAt: now,
      jti: "j1",
      kind: "member",
      name: "Ann",
      participantId: "u:u1",
      role: "editor",
      version: 1,
      workspaceId: "w1",
    }),
    key
  );
  expect(await verify(ticket)).toBeNull();
});

const ticketFor = (over: Record<string, unknown> = {}) =>
  signRoomTicket(
    roomTicketClaimsSchema.parse({
      artifactId,
      audience: "artifact-room",
      color: "#059669",
      connectionExpiresAt: now + 120,
      expiresAt: now + 60,
      issuedAt: now,
      jti: "j1",
      kind: "member",
      name: "Ann",
      participantId: "u:u1",
      role: "editor",
      version: 1,
      workspaceId: "w1",
      ...over,
    }),
    key
  );
const requestWith = (header?: string) =>
  new Request("https://hm.test/api/rooms/x", {
    headers: header === undefined ? {} : { [ADMISSION_HEADER]: header },
  });

test("the room trusts a valid assertion and skips its own authentication", async () => {
  const header = await signRoomAdmission(admission(), key);
  const got = await admissionFromRequest(
    requestWith(header),
    await ticketFor(),
    key,
    scope,
    now
  );
  expect(got.status).toBe("trusted");
});

test("no header means the request did not come through the route", async () => {
  const got = await admissionFromRequest(
    requestWith(),
    await ticketFor(),
    key,
    scope,
    now
  );
  expect(got.status).toBe("absent");
});

test("a present but wrong assertion is refused, never downgraded", async () => {
  const header = await signRoomAdmission(admission(), key);
  const ticket = await ticketFor();
  const refused = async (request: Request, t: string, at = now) =>
    (await admissionFromRequest(request, t, key, scope, at)).status;
  expect(await refused(requestWith("hm_adm_forged.forged"), ticket)).toBe(
    "refused"
  );
  // Another ticket id, an expired or forged ticket, and an expired assertion.
  expect(
    await refused(requestWith(header), await ticketFor({ jti: "j2" }))
  ).toBe("refused");
  expect(await refused(requestWith(header), "hm_room_forged.forged")).toBe(
    "refused"
  );
  expect(await refused(requestWith(header), ticket, now + 61)).toBe("refused");
  expect(await refused(requestWith(header), ticket, now + 30)).toBe("refused");
  // Another room's ticket.
  expect(
    await refused(
      requestWith(header),
      await ticketFor({ artifactId: crypto.randomUUID() })
    )
  ).toBe("refused");
});

test("room admission runs Clerk once: a signed request never authenticates again", async () => {
  let clerk = 0;
  const authenticate = () => {
    clerk += 1;
    return Promise.resolve({ principal });
  };
  const bound = { key, scope, ticket: await ticketFor() };
  const header = await signRoomAdmission(admission(), key);
  const trusted = await requestMember(
    authenticate,
    bound,
    requestWith(header),
    now
  );
  expect(trusted?.verified).toEqual(principal);
  expect(trusted?.sessionId).toBe("sess_1");
  expect(clerk).toBe(0);
  // Without the route's assertion the room authenticates in full, once.
  expect(
    (await requestMember(authenticate, bound, requestWith(), now))?.principal
  ).toEqual(principal);
  expect(clerk).toBe(1);
});

test("a wrong assertion is refused without falling back to a full check", async () => {
  let clerk = 0;
  const authenticate = () => {
    clerk += 1;
    return Promise.resolve({ principal });
  };
  const header = await signRoomAdmission(admission(), key);
  const forged = await requestMember(
    authenticate,
    { key, scope, ticket: await ticketFor() },
    requestWith("hm_adm_forged.forged"),
    now
  );
  const otherTicket = await requestMember(
    authenticate,
    { key, scope, ticket: await ticketFor({ jti: "j2" }) },
    requestWith(header),
    now
  );
  const otherRoom = await requestMember(
    authenticate,
    {
      key,
      scope: { ...scope, artifactId: crypto.randomUUID() },
      ticket: await ticketFor(),
    },
    requestWith(header),
    now
  );
  expect([forged, otherTicket, otherRoom]).toEqual([null, null, null]);
  expect(clerk).toBe(0);
});

test("a ticket's own payload and signature never verify as an assertion", async () => {
  const [payload, signature] = (await ticketFor())
    .slice("hm_room_".length)
    .split(".");
  expect(await verify(`hm_adm_${payload}.${signature}`)).toBeNull();
});

test("an assertion minted before signClaims still verifies, and the new one is the same bytes", async () => {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`room-admission:${key}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const payload = Buffer.from(JSON.stringify(admission())).toString(
    "base64url"
  );
  const mac = Buffer.from(
    await crypto.subtle.sign("HMAC", hmac, encoder.encode(payload))
  ).toString("base64url");
  const old = `${(await signRoomAdmission(admission(), key)).split(payload)[0]}${payload}.${mac}`;
  expect((await verify(old))?.principal).toEqual(principal);
  expect(await signRoomAdmission(admission(), key)).toBe(old);
});
