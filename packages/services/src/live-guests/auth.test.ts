import { describe, expect, test } from "bun:test";
import type { Atomic } from "@repo/db/atomic";
import { artifacts } from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import {
  artifactMembers,
  guestAuthRateBuckets,
  guestCodes,
  guestIdentities,
  guestInvites,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { eq, isNull } from "drizzle-orm";
import { harness, principals } from "../artifacts/test-harness.ts";
import { hashToken } from "../crypto.ts";
import { createGuestAccessReader } from "./access.ts";
import { createGuestAuthService } from "./auth.ts";
import { createGuestInvitations } from "./invitations.ts";
import type { GuestEmailPort } from "./ports.ts";
import { createGuestCodeHasher } from "./security.ts";
import { createLiveGuestsService } from "./service.ts";
import { createGuestSessionLifecycle } from "./sessions.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const EXPIRY = "2026-10-28T00:00:00.000Z";
const PEPPER = new Uint8Array(32).fill(17);
const CODE_PATTERN = /^\d{6}$/;
const IP = "192.0.2.123";
const setup = async () => {
  const h = harness();
  let at = new Date(NOW);
  let off = false;
  let failMail = false;
  let beforeAtomic: (() => Promise<void>) | undefined;
  const clock = { now: () => at, sleep: () => Promise.resolve() };
  const invitations: Parameters<GuestEmailPort["sendInvitation"]>[0][] = [];
  const mails: Parameters<GuestEmailPort["sendCode"]>[0][] = [];
  const email: GuestEmailPort = {
    sendCode: (input) => {
      if (failMail) {
        throw new Error("sender failed");
      }
      mails.push(input);
      return Promise.resolve();
    },
    sendInvitation: (input) => {
      invitations.push(input);
      return Promise.resolve();
    },
  };
  const guestsOff = () => off;
  const invitationService = createGuestInvitations({
    atomic: h.atomic,
    clock,
    db: h.db,
    directory: { findMemberByEmail: () => Promise.resolve(null) },
    email,
    events: h.events,
    guestsOff,
    invalidations: { trigger: () => Promise.resolve() },
    inviterName: () => Promise.resolve("Inviter"),
    origin: "https://example.com",
  });
  const authDeps = {
    atomic: async (statements: Parameters<Atomic>[0]) => {
      await beforeAtomic?.();
      await h.atomic(statements);
    },
    clock,
    db: h.db,
    email,
    events: h.events,
    guestsOff,
    inviterName: () => Promise.resolve("Inviter"),
    pepper: PEPPER,
  };
  const auth = await createGuestAuthService(authDeps);
  const reader = createGuestAccessReader({ clock, db: h.db, guestsOff });
  const sessions = createGuestSessionLifecycle({
    atomic: h.atomic,
    clock,
    db: h.db,
    guestsOff,
  });
  const invite = async (address = "client@example.com") => {
    const artifactId = crypto.randomUUID();
    h.db
      .insert(artifacts)
      .values({
        audience: "private",
        createdAt: NOW,
        createdById: "u1",
        createdByKind: "user",
        id: artifactId,
        kind: "document",
        ownerUserId: "u1",
        title: "Client document",
        updatedAt: NOW,
        workspaceId: "w1",
      })
      .run();
    const grant = await invitationService.invite(principals.owner, {
      artifactId,
      email: address,
      expiresAt: EXPIRY,
      role: "editor",
    });
    const mail = invitations.at(-1);
    if (!mail) {
      throw new Error("No invitation");
    }
    return {
      artifactId,
      inviteToken: new URL(mail.url).pathname.slice(3),
      memberId: grant.memberId,
      workspaceId: "w1",
    };
  };
  const advance = (seconds: number) => {
    at = new Date(at.getTime() + seconds * 1000);
  };
  return {
    ...h,
    advance,
    auth,
    authDeps,
    beforeAtomic: (callback: () => Promise<void>) => {
      beforeAtomic = callback;
    },
    clock,
    email,
    failMail: () => {
      failMail = true;
    },
    invitationService,
    invite,
    mails,
    reader,
    sessions,
    setOff: (value: boolean) => {
      off = value;
    },
  };
};
const wrongCode = (actual: string) =>
  actual === "000000" ? "111111" : "000000";
const cookieToken = (cookie: string) =>
  cookie.split(";")[0]?.slice("__Host-hm_guest=".length) ?? "";
const lastCode = (h: Awaited<ReturnType<typeof setup>>) => {
  const mail = h.mails.at(-1);
  if (!mail) {
    throw new Error("No code mail");
  }
  return mail.code;
};

describe("guest OTP, actual migrated DB and Web Crypto", () => {
  test("composed scanner landing supplies trusted inviter name without any DB writes or sends", async () => {
    const h = await setup();
    const invite = await h.invite();
    const service = await createLiveGuestsService({
      ...h.authDeps,
      directory: { findMemberByEmail: () => Promise.resolve(null) },
      invalidations: { trigger: () => Promise.resolve() },
      origin: "https://example.com",
    });
    const before = h.db.client.serialize();
    expect(await service.invitation("w1", invite.inviteToken)).toMatchObject({
      artifactTitle: "Client document",
      expiresAt: EXPIRY,
      inviterName: "Inviter",
      role: "editor",
    });
    expect(h.db.client.serialize()).toEqual(before);
    expect(h.mails).toHaveLength(0);
    expect(await service.invitation("w2", invite.inviteToken)).toBeNull();
  });
  test("explicit code request stores only context-bound hash and sends required data; verify consumes and signs in", async () => {
    const h = await setup();
    const invite = await h.invite();
    expect(h.mails).toHaveLength(0);
    expect(await h.auth.requestCode({ ...invite, ip: IP })).toEqual({
      accepted: true,
    });
    const code = lastCode(h);
    expect(code).toMatch(CODE_PATTERN);
    expect(h.mails[0]).toMatchObject({
      artifactTitle: "Client document",
      codeExpiresAt: "2026-10-27T00:10:00.000Z",
      expiresAt: EXPIRY,
      inviterName: "Inviter",
      role: "editor",
      to: "client@example.com",
      workspaceName: "W1",
    });
    const [stored] = h.db.select().from(guestCodes).all();
    if (!stored) {
      throw new Error("No challenge");
    }
    const hasher = await createGuestCodeHasher(PEPPER);
    expect(stored.codeHash).toBe(
      await hasher(code, {
        codeId: stored.id,
        guestId: stored.guestId,
        inviteId: stored.inviteId,
        workspaceId: stored.workspaceId,
      })
    );
    expect(stored.codeHash).not.toBe(await hashToken(code));
    const signed = await h.auth.verify({
      ...invite,
      code,
      ip: IP,
      userAgent: " Browser ",
    });
    expect(signed.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(signed.location).toBe(`/g/a/${invite.artifactId}`);
    const token = cookieToken(signed.cookie);
    const [session] = h.db.select().from(guestSessions).all();
    expect(session).toMatchObject({
      expiresAt: "2026-10-27T12:00:00.000Z",
      ipPrefix: "192.0.2.0/24",
      tokenHash: await hashToken(token),
      userAgent: "Browser",
    });
    expect(h.db.select().from(guestCodes).all()[0]).toMatchObject({
      attempts: 1,
      consumedAt: NOW,
    });
    expect(h.db.select().from(guestInvites).all()[0]?.usedAt).toBe(NOW);
    expect(
      await h.reader.resolve({
        artifactId: invite.artifactId,
        sessionToken: token,
        workspaceId: "w1",
      })
    ).toMatchObject({ role: "editor" });
    const audited = h.db.select().from(events).all();
    expect(
      audited.filter((e) => e.type === "artifact.guest_code_sent")
    ).toHaveLength(1);
    expect(
      audited.filter((e) => e.type === "artifact.guest_signed_in")
    ).toHaveLength(1);
    expect(
      audited.every((e) => e.actorKind === "user" && e.actorId === "u1")
    ).toBe(true);
    expect(JSON.stringify(audited)).not.toContain(code);
    expect(JSON.stringify(audited)).not.toContain(token);
    expect(
      JSON.stringify(h.db.select().from(guestAuthRateBuckets).all())
    ).not.toContain("client@example.com");
    expect(
      JSON.stringify(h.db.select().from(guestAuthRateBuckets).all())
    ).not.toContain("192.0.2");
    await expect(h.auth.verify({ ...invite, code })).rejects.toThrow(
      "Guest access unavailable"
    );
    await h.sessions.signout({ sessionToken: token, workspaceId: "w1" });
    expect(
      await h.reader.resolve({
        artifactId: invite.artifactId,
        sessionToken: token,
        workspaceId: "w1",
      })
    ).toBeNull();
  });
  test("twenty concurrent correct replays produce one session and sign-in event", async () => {
    const h = await setup();
    const invite = await h.invite();
    await h.auth.requestCode({ ...invite, ip: IP });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        h.auth.verify({ ...invite, code: lastCode(h) })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.db.select().from(guestSessions).all()).toHaveLength(1);
    expect(h.db.select().from(guestCodes).all()[0]?.attempts).toBe(1);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.guest_signed_in"))
        .all()
    ).toHaveLength(1);
  });
  test("concurrent wrong guesses charge exactly five attempts, then correct code is refused", async () => {
    const h = await setup();
    const invite = await h.invite();
    await h.auth.requestCode({ ...invite, ip: IP });
    const code = lastCode(h);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        h.auth.verify({ ...invite, code: wrongCode(code) })
      )
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(h.db.select().from(guestCodes).all()[0]).toMatchObject({
      attempts: 5,
      consumedAt: NOW,
    });
    await expect(h.auth.verify({ ...invite, code })).rejects.toThrow(
      "Guest access unavailable"
    );
    expect(h.db.select().from(guestSessions).all()).toHaveLength(0);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.guest_signed_in"))
        .all()
    ).toHaveLength(0);
  });
  test("ten-minute expiry and malformed guesses; fifth correct guess is allowed", async () => {
    const h = await setup();
    const invite = await h.invite();
    await h.auth.requestCode({ ...invite, ip: IP });
    await expect(
      h.auth.verify({ ...invite, code: "malformed" })
    ).rejects.toThrow("Guest access unavailable");
    expect(h.db.select().from(guestCodes).all()[0]?.attempts).toBe(1);
    h.advance(600);
    await expect(
      h.auth.verify({ ...invite, code: lastCode(h) })
    ).rejects.toThrow("Guest access unavailable");
    await h.auth.requestCode({ ...invite, ip: IP });
    const code = lastCode(h);
    for (let index = 0; index < 4; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: test sequential attempt charging before fifth success
      await expect(
        h.auth.verify({ ...invite, code: wrongCode(code) })
      ).rejects.toThrow();
    }
    expect((await h.auth.verify({ ...invite, code })).grant.artifactId).toBe(
      invite.artifactId
    );
  });
  test("durable minute/hour invite ceilings survive service recreation; resend supersedes", async () => {
    const h = await setup();
    const invite = await h.invite();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        h.auth.requestCode({ ...invite, ip: IP })
      )
    );
    expect(responses.every((r) => r.accepted)).toBe(true);
    expect(h.mails).toHaveLength(1);
    expect(h.db.select().from(guestCodes).all()).toHaveLength(1);
    const recreated = await createGuestAuthService(h.authDeps);
    await recreated.requestCode({ ...invite, ip: "192.0.3.55" });
    expect(h.mails).toHaveLength(1);
    h.advance(60);
    await recreated.requestCode({ ...invite, ip: IP });
    expect(h.mails).toHaveLength(2);
    expect(
      h.db
        .select()
        .from(guestCodes)
        .all()
        .filter((c) => c.consumedAt === null)
    ).toHaveLength(1);
    h.advance(60);
    await recreated.requestCode({ ...invite, ip: IP });
    h.advance(60);
    await recreated.requestCode({ ...invite, ip: IP });
    expect(h.mails).toHaveLength(3);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.guest_code_sent"))
        .all()
    ).toHaveLength(3);
    expect(
      h.db
        .select()
        .from(guestAuthRateBuckets)
        .all()
        .every((b) => b.count <= b.limit)
    ).toBe(true);
  });
  test("email ceiling spans invitations; all bucket reservations roll back on a single exceeded bucket", async () => {
    const h = await setup();
    const invites: Awaited<ReturnType<typeof h.invite>>[] = [];
    for (let index = 0; index < 7; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: establish identity before exercising concurrent code sends
      invites.push(await h.invite());
    }
    await Promise.all(
      invites.map((invite, index) =>
        h.auth.requestCode({ ...invite, ip: `192.0.${index}.1` })
      )
    );
    expect(h.mails).toHaveLength(6);
    expect(h.db.select().from(guestCodes).all()).toHaveLength(6);
    const buckets = h.db.select().from(guestAuthRateBuckets).all();
    expect(buckets.filter((b) => b.kind === "email")).toHaveLength(1);
    expect(buckets.find((b) => b.kind === "email")?.count).toBe(6);
    expect(buckets.filter((b) => b.kind === "invite")).toHaveLength(12);
    expect(buckets.filter((b) => b.kind === "ip_prefix")).toHaveLength(6);
  });
  test("IP prefix ceiling spans different guests and host addresses", async () => {
    const h = await setup();
    const invites: Awaited<ReturnType<typeof h.invite>>[] = [];
    for (let index = 0; index < 31; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: invite creation is deliberately serialized for one workspace DB
      invites.push(await h.invite(`client${index}@example.com`));
    }
    await Promise.all(
      invites.map((invite, index) =>
        h.auth.requestCode({ ...invite, ip: `192.0.2.${index + 1}` })
      )
    );
    expect(h.mails).toHaveLength(30);
    expect(
      h.db
        .select()
        .from(guestAuthRateBuckets)
        .where(eq(guestAuthRateBuckets.kind, "ip_prefix"))
        .all()
    ).toHaveLength(1);
    expect(
      h.db
        .select()
        .from(guestAuthRateBuckets)
        .where(eq(guestAuthRateBuckets.kind, "ip_prefix"))
        .all()[0]?.count
    ).toBe(30);
  });
  test("request response is generic for missing/expired/off/IP-invalid and failed mail remains charged", async () => {
    const h = await setup();
    const invite = await h.invite();
    expect(
      await h.auth.requestCode({ ...invite, inviteToken: "bad", ip: IP })
    ).toEqual({ accepted: true });
    expect(await h.auth.requestCode({ ...invite, ip: "not-an-IP" })).toEqual({
      accepted: true,
    });
    h.setOff(true);
    expect(await h.auth.requestCode({ ...invite, ip: IP })).toEqual({
      accepted: true,
    });
    await expect(h.auth.verify({ ...invite, code: "000000" })).rejects.toThrow(
      "Guest access unavailable"
    );
    h.setOff(false);
    expect(h.db.select().from(guestAuthRateBuckets).all()).toHaveLength(0);
    h.failMail();
    await h.auth.requestCode({ ...invite, ip: IP });
    expect(h.db.select().from(guestAuthRateBuckets).all()).toHaveLength(4);
    await h.auth.requestCode({ ...invite, ip: IP });
    expect(h.db.select().from(guestCodes).all()).toHaveLength(1);
  });
  test("audit failure rolls back bucket/code/session and code consumption; retry can succeed", async () => {
    const h = await setup();
    const invite = await h.invite();
    h.db.client.run(
      "CREATE TRIGGER refuse_guest_event BEFORE INSERT ON events WHEN NEW.type LIKE 'artifact.guest_%' BEGIN SELECT RAISE(ABORT, 'audit failed'); END"
    );
    await h.auth.requestCode({ ...invite, ip: IP });
    expect(h.mails).toHaveLength(0);
    expect(h.db.select().from(guestCodes).all()).toHaveLength(0);
    expect(h.db.select().from(guestAuthRateBuckets).all()).toHaveLength(0);
    h.db.client.run("DROP TRIGGER refuse_guest_event");
    await h.auth.requestCode({ ...invite, ip: IP });
    const code = lastCode(h);
    h.db.client.run(
      "CREATE TRIGGER refuse_signin BEFORE INSERT ON events WHEN NEW.type = 'artifact.guest_signed_in' BEGIN SELECT RAISE(ABORT, 'audit failed'); END"
    );
    await expect(h.auth.verify({ ...invite, code })).rejects.toThrow(
      "Guest access unavailable"
    );
    expect(h.db.select().from(guestSessions).all()).toHaveLength(0);
    expect(h.db.select().from(guestCodes).all()[0]).toMatchObject({
      attempts: 0,
      consumedAt: null,
    });
    h.db.client.run("DROP TRIGGER refuse_signin");
    await h.auth.verify({ ...invite, code });
    expect(h.db.select().from(guestSessions).all()).toHaveLength(1);
  });
  test("revocation before commit kills pending OTP even with another live grant; forged workspace parents refuse", async () => {
    const h = await setup();
    const invite = await h.invite();
    await h.invite();
    await h.auth.requestCode({ ...invite, ip: IP });
    const code = lastCode(h);
    h.beforeAtomic(() =>
      h.invitationService.revoke(principals.owner, {
        artifactId: invite.artifactId,
        memberId: invite.memberId,
      })
    );
    await expect(h.auth.verify({ ...invite, code })).rejects.toThrow(
      "Guest access unavailable"
    );
    expect(h.db.select().from(guestSessions).all()).toHaveLength(0);
    const h2 = await setup();
    const invite2 = await h2.invite();
    await h2.auth.requestCode({ ...invite2, ip: IP });
    await expect(
      h2.auth.verify({ ...invite2, code: lastCode(h2), workspaceId: "w2" })
    ).rejects.toThrow("Guest access unavailable");
    h2.db.update(guestIdentities).set({ workspaceId: "w2" }).run();
    await expect(
      h2.auth.verify({ ...invite2, code: lastCode(h2) })
    ).rejects.toThrow("Guest access unavailable");
  });
  test("one identity session resolves only its explicit grants; transplanted challenge hash cannot sign in", async () => {
    const h = await setup();
    const first = await h.invite();
    const second = await h.invite();
    await h.auth.requestCode({ ...first, ip: IP });
    const code = lastCode(h);
    const signed = await h.auth.verify({ ...first, code });
    const sessionToken = cookieToken(signed.cookie);
    expect(
      await h.reader.resolve({
        artifactId: second.artifactId,
        sessionToken,
        workspaceId: "w1",
      })
    ).toMatchObject({ artifactId: second.artifactId });
    expect(
      await h.reader.resolve({
        artifactId: crypto.randomUUID(),
        sessionToken,
        workspaceId: "w1",
      })
    ).toBeNull();
    h.advance(60);
    await h.auth.requestCode({ ...first, ip: IP });
    const freshCode = lastCode(h);
    const secondInvite = h.db
      .select()
      .from(guestInvites)
      .all()
      .find((row) => row.memberId === second.memberId);
    if (!secondInvite) {
      throw new Error("Missing second invitation");
    }
    h.db
      .update(guestCodes)
      .set({ inviteId: secondInvite.id })
      .where(isNull(guestCodes.consumedAt))
      .run();
    await expect(h.auth.verify({ ...second, code: freshCode })).rejects.toThrow(
      "Guest access unavailable"
    );
    expect(h.db.select().from(guestSessions).all()).toHaveLength(1);
  });
  test("workspace/emergency/deletion/expiry checks apply to pending codes and existing sessions", async () => {
    const h = await setup();
    const invite = await h.invite();
    await h.auth.requestCode({ ...invite, ip: IP });
    const code = lastCode(h);
    h.db
      .update(workspaces)
      .set({ liveGuestsEnabled: false })
      .where(eq(workspaces.id, "w1"))
      .run();
    await expect(h.auth.verify({ ...invite, code })).rejects.toThrow(
      "Guest access unavailable"
    );
    h.db
      .update(workspaces)
      .set({ liveGuestsEnabled: true })
      .where(eq(workspaces.id, "w1"))
      .run();
    const signed = await h.auth.verify({ ...invite, code });
    const input = {
      artifactId: invite.artifactId,
      sessionToken: cookieToken(signed.cookie),
      workspaceId: "w1",
    };
    h.setOff(true);
    expect(await h.reader.resolve(input)).toBeNull();
    await expect(h.sessions.renew(input)).rejects.toThrow(
      "Guest access unavailable"
    );
    h.setOff(false);
    h.db
      .update(artifacts)
      .set({ deletedAt: NOW })
      .where(eq(artifacts.id, invite.artifactId))
      .run();
    expect(await h.reader.resolve(input)).toBeNull();
    h.db
      .update(artifacts)
      .set({ deletedAt: null })
      .where(eq(artifacts.id, invite.artifactId))
      .run();
    h.db
      .update(artifactMembers)
      .set({ expiresAt: NOW })
      .where(eq(artifactMembers.id, invite.memberId))
      .run();
    expect(await h.reader.resolve(input)).toBeNull();
  });
});
