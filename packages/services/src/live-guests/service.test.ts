import { describe, expect, test } from "bun:test";
import { artifacts, artifactViews } from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import {
  artifactMembers,
  artifactRoomInvalidations,
  guestIdentities,
  guestInvites,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { eq } from "drizzle-orm";
import { harness, principals } from "../artifacts/test-harness.ts";
import { hashToken } from "../crypto.ts";
import type { Principal } from "../workspaces.ts";
import { createGuestAccessReader } from "./access.ts";
import { createGuestInvitations } from "./invitations.ts";
import type { GuestEmailPort } from "./ports.ts";
import {
  clearGuestSessionCookie,
  createGuestCodeHasher,
  guestSessionCookie,
  newGuestCode,
  newGuestSessionToken,
} from "./security.ts";

import { createGuestSessionLifecycle } from "./sessions.ts";

const CODE_PATTERN = /^\d{6}$/;
const NOW = "2026-10-27T00:00:00.000Z";
const EXPIRY = "2026-10-28T00:00:00.000Z";
const setup = () => {
  const h = harness();
  const published = { artifactId: crypto.randomUUID() };
  h.db
    .insert(artifacts)
    .values({
      audience: "private",
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      id: published.artifactId,
      kind: "document",
      ownerUserId: "u1",
      title: "Invitation test",
      updatedAt: NOW,
      workspaceId: "w1",
    })
    .run();
  const emails: Parameters<GuestEmailPort["sendInvitation"]>[0][] = [];
  let off = false;
  let date = new Date(NOW);
  let deliveryFails = false;
  let directoryFails = false;
  const clock = { now: () => date, sleep: () => Promise.resolve() };
  const service = createGuestInvitations({
    atomic: h.atomic,
    clock,
    db: h.db,
    directory: {
      findMemberByEmail: ({ email }) => {
        if (directoryFails) {
          throw new Error("directory unavailable");
        }
        return Promise.resolve(
          email === "member@example.com"
            ? { displayName: "Member", userId: "u2" }
            : null
        );
      },
    },
    email: {
      sendCode: () => {
        throw new Error("Not implemented");
      },
      sendInvitation: (mail) => {
        emails.push(mail);
        return Promise.resolve();
      },
    },
    events: h.events,
    guestsOff: () => off,
    invalidations: {
      trigger: () =>
        deliveryFails
          ? Promise.reject(new Error("delivery unavailable"))
          : Promise.resolve(),
    },
    inviterName: () => Promise.resolve("Owner"),
    origin: "https://example.com",
  });
  const reader = createGuestAccessReader({
    clock,
    db: h.db,
    guestsOff: () => off,
  });
  const invite = () =>
    service.invite(principals.owner, {
      artifactId: published.artifactId,
      email: "Client@Example.com",
      expiresAt: EXPIRY,
      role: "editor",
    });
  return {
    ...h,
    artifactId: published.artifactId,
    clock,
    emails,
    failDelivery: () => {
      deliveryFails = true;
    },
    failDirectory: () => {
      directoryFails = true;
    },
    invite,
    reader,
    service,
    setDate: (value: string) => {
      date = new Date(value);
    },
    setOff: (value: boolean) => {
      off = value;
    },
  };
};
const session = async (h: Awaited<ReturnType<typeof setup>>) => {
  const token = await newGuestSessionToken();
  const [identity] = h.db.select().from(guestIdentities).all();
  if (!identity) {
    throw new Error("Missing guest");
  }
  h.db
    .insert(guestSessions)
    .values({
      createdAt: NOW,
      expiresAt: EXPIRY,
      guestId: identity.id,
      id: "session",
      lastUsedAt: NOW,
      tokenHash: token.hash,
      workspaceId: "w1",
    })
    .run();
  return {
    artifactId: h.artifactId,
    sessionToken: token.token,
    workspaceId: "w1",
  };
};

describe("guest invitation boundary (migrated DB)", () => {
  test("outsiders require expiry, named members use user grants, directory failure fails closed", async () => {
    const h = await setup();
    await expect(
      h.service.invite(principals.owner, {
        artifactId: h.artifactId,
        email: "outside@example.com",
        role: "viewer",
      })
    ).rejects.toThrow("expiry");
    const named = await h.service.invite(principals.owner, {
      artifactId: h.artifactId,
      email: "member@example.com",
      role: "commenter",
    });
    expect(named.principalKind).toBe("user");
    expect(h.db.select().from(guestIdentities).all()).toHaveLength(0);
    expect(h.db.select().from(guestInvites).all()).toHaveLength(0);
    expect(h.emails[0]?.url).toBe(`https://example.com/a/${h.artifactId}`);
    h.failDirectory();
    await expect(h.invite()).rejects.toThrow("directory unavailable");
    expect(h.db.select().from(artifactMembers).all()).toHaveLength(1);
  });
  test("owner/admin only, no cross-workspace or read-only grants", async () => {
    const h = await setup();
    for (const principal of [
      principals.stranger,
      principals.otherWorkspace,
      principals.keyReader,
      principals.agentOne,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential refusal checks
      await expect(
        h.service.invite(principal, {
          artifactId: h.artifactId,
          email: "outside@example.com",
          expiresAt: EXPIRY,
          role: "viewer",
        })
      ).rejects.toThrow();
    }
    await h.service.invite(principals.admin, {
      artifactId: h.artifactId,
      email: "outside@example.com",
      expiresAt: EXPIRY,
      role: "viewer",
    });
    expect(h.db.select().from(artifactMembers).all()).toHaveLength(1);
  });
  test("invite token hashed; landing is read only; mail includes all required data", async () => {
    const h = await setup();
    await h.invite();
    const [mail] = h.emails;
    if (!mail) {
      throw new Error("Missing mail");
    }
    expect(mail).toMatchObject({
      artifactTitle: "Invitation test",
      expiresAt: EXPIRY,
      inviterName: "Owner",
      role: "editor",
      to: "client@example.com",
      workspaceName: "W1",
    });
    const token = new URL(mail.url).pathname.slice(3);
    const [stored] = h.db.select().from(guestInvites).all();
    expect(stored?.tokenHash).toBe(await hashToken(token));
    const before = h.db.client.serialize();
    expect(await h.reader.invitation("w1", token)).toMatchObject({
      artifactTitle: "Invitation test",
    });
    expect(await h.reader.invitation("w2", token)).toBeNull();
    expect(h.db.client.serialize()).toEqual(before);
    const serialized = JSON.stringify(h.db.select().from(events).all());
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("client@example.com");
  });
  test("each session read checks current role, revoke, expiry and both switches", async () => {
    const h = await setup();
    const invited = await h.invite();
    const input = await session(h);
    expect(await h.reader.resolve(input)).toMatchObject({
      artifactId: h.artifactId,
      role: "editor",
    });
    h.setOff(true);
    expect(await h.reader.resolve(input)).toBeNull();
    h.setOff(false);
    h.db
      .update(workspaces)
      .set({ liveGuestsEnabled: false })
      .where(eq(workspaces.id, "w1"))
      .run();
    expect(await h.reader.resolve(input)).toBeNull();
    h.db
      .update(workspaces)
      .set({ liveGuestsEnabled: true })
      .where(eq(workspaces.id, "w1"))
      .run();
    await h.service.changeRole(principals.owner, {
      artifactId: h.artifactId,
      memberId: invited.memberId,
      role: "viewer",
    });
    expect(await h.reader.resolve(input)).toMatchObject({ role: "viewer" });
    h.setDate(EXPIRY);
    expect(await h.reader.resolve(input)).toBeNull();
    h.setDate(NOW);
    await h.service.revoke(principals.owner, {
      artifactId: h.artifactId,
      memberId: invited.memberId,
    });
    expect(await h.reader.resolve(input)).toBeNull();
    expect(
      await h.reader.invitation(
        "w1",
        new URL(h.emails[0]?.url ?? "").pathname.slice(3)
      )
    ).toBeNull();
  });
  test("forged cross-workspace parent and arbitrary artifact do not inherit access", async () => {
    const h = await setup();
    const invited = await h.invite();
    const input = await session(h);
    expect(await h.reader.resolve({ ...input, workspaceId: "w2" })).toBeNull();
    expect(
      await h.reader.resolve({ ...input, artifactId: crypto.randomUUID() })
    ).toBeNull();
    h.db.update(guestIdentities).set({ workspaceId: "w2" }).run();
    expect(await h.reader.resolve(input)).toBeNull();
    await expect(
      h.service.revoke(principals.owner, {
        artifactId: h.artifactId,
        memberId: invited.memberId,
      })
    ).rejects.toThrow();
  });
  test("competing revokes commit only one event/outbox", async () => {
    const h = setup();
    const invited = await h.invite();
    const results = await Promise.allSettled([
      h.service.revoke(principals.owner, {
        artifactId: h.artifactId,
        memberId: invited.memberId,
      }),
      h.service.revoke(principals.owner, {
        artifactId: h.artifactId,
        memberId: invited.memberId,
      }),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.member_revoked"))
        .all()
    ).toHaveLength(1);
    expect(h.db.select().from(artifactRoomInvalidations).all()).toHaveLength(1);
  });
  test("outbox committed with mutation/event before failed delivery, no false audit on rollback", async () => {
    const h = await setup();
    const invited = await h.invite();
    h.failDelivery();
    await expect(
      h.service.revoke(principals.owner, {
        artifactId: h.artifactId,
        memberId: invited.memberId,
      })
    ).rejects.toThrow("delivery unavailable");
    expect(h.db.select().from(artifactMembers).all()[0]?.revokedAt).toBe(NOW);
    expect(h.db.select().from(artifactRoomInvalidations).all()).toHaveLength(1);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.member_revoked"))
        .all()
    ).toHaveLength(1);
    const h2 = await setup();
    const invited2 = await h2.invite();
    h2.db.client.run(
      "CREATE TRIGGER refuse_invalidation BEFORE INSERT ON artifact_room_invalidations BEGIN SELECT RAISE(ABORT, 'outbox failed'); END"
    );
    await expect(
      h2.service.revoke(principals.owner, {
        artifactId: h2.artifactId,
        memberId: invited2.memberId,
      })
    ).rejects.toThrow();
    expect(h2.db.select().from(artifactMembers).all()[0]?.revokedAt).toBeNull();
    expect(
      h2.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.member_revoked"))
        .all()
    ).toHaveLength(0);
  });
});

describe("guest sessions (existing authenticated rows)", () => {
  const lifecycle = (h: ReturnType<typeof setup>, atomic = h.atomic) =>
    createGuestSessionLifecycle({
      atomic,
      clock: h.clock,
      db: h.db,
      guestsOff: () => false,
    });
  test("opens audit guest surface, rotate on use, renew for twelve hours and signout", async () => {
    const h = setup();
    await h.invite();
    const input = await session(h);
    const service = lifecycle(h);
    const opened = await service.open(input, {
      country: "AU",
      ipPrefix: "192.0.2.0/24",
    });
    expect(opened.grant.role).toBe("editor");
    const [view] = h.db.select().from(artifactViews).all();
    expect(view).toMatchObject({
      country: "AU",
      ipPrefix: "192.0.2.0/24",
      outcome: "ok",
      surface: "guest",
    });
    expect(await h.reader.resolve(input)).toBeNull();
    const rotated =
      opened.cookie.split(";")[0]?.slice("__Host-hm_guest=".length) ?? "";
    const next = { ...input, sessionToken: rotated };
    expect(await h.reader.resolve(next)).not.toBeNull();
    const renewed = await service.renew(next);
    expect(renewed.expiresAt).toBe("2026-10-27T12:00:00.000Z");
    const token =
      renewed.cookie.split(";")[0]?.slice("__Host-hm_guest=".length) ?? "";
    await service.signout({ sessionToken: token, workspaceId: "w1" });
    expect(
      await h.reader.resolve({ ...input, sessionToken: token })
    ).toBeNull();
    expect(h.db.select().from(guestSessions).all()).toHaveLength(0);
    expect(h.db.select().from(artifactViews).all()).toHaveLength(1);
  });
  test("concurrent replay rotates/audits once and deleted or revoked sessions cannot race preflight", async () => {
    const h = setup();
    await h.invite();
    const input = await session(h);
    const service = lifecycle(h);
    const results = await Promise.allSettled([
      service.open(input),
      service.open(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(h.db.select().from(artifactViews).all()).toHaveLength(1);
    const h2 = setup();
    const invited = await h2.invite();
    const input2 = await session(h2);
    const racing = lifecycle(h2, async (statements) => {
      await h2.service.revoke(principals.owner, {
        artifactId: h2.artifactId,
        memberId: invited.memberId,
      });
      await h2.atomic(statements);
    });
    await expect(racing.open(input2)).rejects.toThrow(
      "Guest access unavailable"
    );
    expect(h2.db.select().from(artifactViews).all()).toHaveLength(0);
    const h3 = setup();
    await h3.invite();
    const input3 = await session(h3);
    const signedOut = lifecycle(h3, async (statements) => {
      h3.db.delete(guestSessions).run();
      await h3.atomic(statements);
    });
    await expect(signedOut.renew(input3)).rejects.toThrow(
      "Guest access unavailable"
    );
  });
});

describe("guest credentials", () => {
  test("CSPRNG opaque tokens and bound private-pepper code hashes", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 100 }, () => newGuestSessionToken())
    );
    expect(new Set(tokens.map((t) => t.token)).size).toBe(100);
    const hash = await createGuestCodeHasher(new Uint8Array(32).fill(7));
    const binding = {
      codeId: "c",
      guestId: "g",
      inviteId: "i",
      workspaceId: "w",
    };
    const value = await hash("001234", binding);
    expect(value).not.toContain("001234");
    expect(await hash("001234", { ...binding, inviteId: "other" })).not.toBe(
      value
    );
    const other = await createGuestCodeHasher(new Uint8Array(32).fill(8));
    expect(await other("001234", binding)).not.toBe(value);
    await expect(createGuestCodeHasher(new Uint8Array(0))).rejects.toThrow();
    for (let index = 0; index < 1000; index += 1) {
      expect(newGuestCode()).toMatch(CODE_PATTERN);
    }
  });
  test("host cookie contract and injection rejection", async () => {
    const { token } = await newGuestSessionToken();
    const cookie = guestSessionCookie(token);
    expect(cookie).toBe(
      `__Host-hm_guest=${token}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
    expect(cookie).not.toContain("Domain");
    expect(clearGuestSessionCookie()).toContain("Max-Age=0");
    expect(() => guestSessionCookie(`${token}; Domain=evil.com`)).toThrow();
    expect(() => guestSessionCookie(token, 43_201)).toThrow();
  });
  test("GuestGrant remains distinct from Principal", () => {
    const typeCheck = (
      grant: NonNullable<
        Awaited<
          ReturnType<ReturnType<typeof createGuestAccessReader>["resolve"]>
        >
      >
    ) => {
      // @ts-expect-error guest grants are never app principals
      const principal: Principal = grant;
      return principal;
    };
    expect(typeCheck).toBeFunction();
  });
});
