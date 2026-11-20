import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";

import {
  createTeamsService,
  profileGetInputSchema,
  profileSetInputSchema,
  setLeadInputSchema,
  setRulesInputSchema,
  slackLinkInputSchema,
  teamCreateInputSchema,
  teamMemberInputSchema,
} from "./teams.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

const NOW = "2026-01-01T00:00:00.000Z";
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createTeamsService>;
const admin: Principal = { ...user, isAdmin: true };
const other: Principal = { ...user, userId: "u2" };

beforeEach(() => {
  db = migrated();
  for (const id of [WORKSPACE, "w2"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: id,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  for (const [id, workspaceId, status] of [
    ["a1", WORKSPACE, "active"],
    ["a2", WORKSPACE, "active"],
    ["old", WORKSPACE, "archived"],
    ["foreign", "w2", "active"],
  ] as const) {
    db.insert(agents)
      .values({
        createdAt: NOW,
        createdBy: "u1",
        id,
        instructions: "",
        model: "m",
        name: id,
        runtime: "fake",
        runtimeConfig: "{}",
        slug: id,
        status,
        workspaceId,
      })
      .run();
  }
  service = createTeamsService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(NOW), sleep: () => Promise.resolve() },
    db,
  });
});

const member = (teamId: string, memberId = "a1", isHome = false) => ({
  isHome,
  memberId,
  memberKind: "agent" as const,
  teamId,
});
const memberRef = (teamId: string, memberId = "a1") => ({
  memberId,
  memberKind: "agent" as const,
  teamId,
});
const seedTeam = (
  id: string,
  values: Partial<typeof teams.$inferInsert> = {}
) => {
  db.insert(teams)
    .values({
      createdAt: NOW,
      id,
      name: id,
      ownerUserId: "u1",
      slug: id,
      workspaceId: WORKSPACE,
      ...values,
    })
    .run();
};
const grants = () => db.select().from(agentLibraryAccess).all();

const profileInput = (handle: string) => ({ handle, name: "Dom" });

test("create parses a padded name and fills the defaults", () => {
  expect(teamCreateInputSchema.parse({ name: "  Ops  " })).toStrictEqual({
    leadAgentId: null,
    leadListens: true,
    name: "Ops",
    rules: "",
  });
});

test("create rejects an empty, whitespace-only or over-long name", () => {
  expect(teamCreateInputSchema.safeParse({ name: "" }).success).toBe(false);
  expect(teamCreateInputSchema.safeParse({ name: "   " }).success).toBe(false);
  expect(
    teamCreateInputSchema.safeParse({ name: "x".repeat(81) }).success
  ).toBe(false);
});

test("create rejects an unknown key", () => {
  expect(
    teamCreateInputSchema.safeParse({ extra: true, name: "Ops" }).success
  ).toBe(false);
});

test("create rejects an invalid slug and accepts a valid one", () => {
  expect(
    teamCreateInputSchema.safeParse({ name: "Ops", slug: "Bad Slug" }).success
  ).toBe(false);
  expect(
    teamCreateInputSchema.parse({ name: "Ops", slug: "ops-team" }).slug
  ).toBe("ops-team");
});

test("team member input defaults isHome to false", () => {
  expect(
    teamMemberInputSchema.parse({
      memberId: "m1",
      memberKind: "agent",
      teamId: "t1",
    }).isHome
  ).toBe(false);
});

test("team member input rejects an unknown member kind and accepts agent and user", () => {
  const input = { memberId: "m1", teamId: "t1" };
  expect(
    teamMemberInputSchema.safeParse({ ...input, memberKind: "robot" }).success
  ).toBe(false);
  expect(
    teamMemberInputSchema.safeParse({ ...input, memberKind: "agent" }).success
  ).toBe(true);
  expect(
    teamMemberInputSchema.safeParse({ ...input, memberKind: "user" }).success
  ).toBe(true);
});

test("set lead accepts a null agent id", () => {
  expect(
    setLeadInputSchema.safeParse({ agentId: null, teamId: "t1" }).success
  ).toBe(true);
});

test("set rules accepts empty rules and rejects rules over 20000 characters", () => {
  expect(
    setRulesInputSchema.safeParse({ rules: "", teamId: "t1" }).success
  ).toBe(true);
  expect(
    setRulesInputSchema.safeParse({ rules: "x".repeat(20_001), teamId: "t1" })
      .success
  ).toBe(false);
});

test("profile set accepts a valid handle", () => {
  expect(profileSetInputSchema.safeParse(profileInput("dom-f")).success).toBe(
    true
  );
});

test("profile set rejects handles that break the handle pattern or length", () => {
  const invalidHandles = ["Dom", "d", "-dom", "dom-", "dom--f", "a".repeat(41)];
  for (const handle of invalidHandles) {
    expect(profileSetInputSchema.safeParse(profileInput(handle)).success).toBe(
      false
    );
  }
});

test("profile get accepts an empty input and a user id", () => {
  expect(profileGetInputSchema.safeParse({}).success).toBe(true);
  expect(profileGetInputSchema.safeParse({ userId: "u1" }).success).toBe(true);
});

test("create makes folders, lead membership, home and write grant", async () => {
  const team = await service.create(user, {
    leadAgentId: "a1",
    name: "  Ops Team ",
  });
  expect(team).toMatchObject({
    archivedAt: null,
    createdAt: NOW,
    folderPath: "teams/ops-team",
    leadAgentId: "a1",
    leadListens: true,
    members: [member(team.id, "a1", true)],
    name: "Ops Team",
    ownerUserId: "u1",
    rules: "",
    slug: "ops-team",
  });
  expect(db.select().from(libraryEntries).all()).toEqual([
    {
      etag: null,
      kind: "dir",
      mtime: NOW,
      parent: "",
      path: "teams",
      size: 0,
      updatedById: "u1",
      updatedByKind: "user",
      workspaceId: WORKSPACE,
    },
    {
      etag: null,
      kind: "dir",
      mtime: NOW,
      parent: "teams",
      path: "teams/ops-team",
      size: 0,
      updatedById: "u1",
      updatedByKind: "user",
      workspaceId: WORKSPACE,
    },
  ]);
  expect(grants()).toMatchObject([
    { agentId: "a1", mode: "write", path: team.folderPath },
  ]);
  await service.create(user, { name: "Second" });
  expect(db.select().from(libraryEntries).all()).toHaveLength(3);
  await expect(
    service.create(user, { name: "Ops Team" })
  ).rejects.toMatchObject({ code: "conflict" });
});

test("reads are workspace scoped, live ordered by name then id, with members", async () => {
  seedTeam("z", { name: "Same" });
  seedTeam("a", { name: "Same" });
  seedTeam("b", { name: "Alpha" });
  seedTeam("archived", { archivedAt: NOW });
  seedTeam("foreign", { workspaceId: "w2" });
  await service.addMember(user, member("a"));
  expect((await service.list(other)).map((t) => t.id)).toEqual(["b", "a", "z"]);
  expect((await service.get(other, "a")).members).toEqual([
    member("a", "a1", true),
  ]);
  expect((await service.get(user, "archived")).archivedAt).toBe(NOW);
  await expect(service.get(user, "foreign")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.update(user, { name: "X", teamId: "foreign" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});

test("owners and admins write; other users and read-only credentials cannot write", async () => {
  seedTeam("t1");
  await service.update(user, { name: "Owner", teamId: "t1" });
  await service.update(admin, { ownerUserId: "u2", teamId: "t1" });
  await expect(
    service.update(user, { name: "No", teamId: "t1" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.create(user, { name: "No", ownerUserId: "u2" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await service.create(admin, { name: "Admin", ownerUserId: "u2" });
  await service.update(other, { name: "New owner", teamId: "t1" });
  await Promise.all(
    [
      user,
      {
        ...other,
        apiKey: { access: "read" as const, id: "key" },
        via: "api_key" as const,
      },
      {
        ...other,
        oauthClient: { access: "read" as const, clientId: "client" },
        via: "oauth" as const,
      },
    ].map(async (denied) => {
      const changes = [
        () => service.update(denied, { name: "No", teamId: "t1" }),
        () => service.archive(denied, "t1"),
        () => service.addMember(denied, member("t1")),
        () => service.removeMember(denied, memberRef("t1")),
        () => service.setLead(denied, { agentId: null, teamId: "t1" }),
        () => service.setRules(denied, { rules: "", teamId: "t1" }),
      ];
      await Promise.all(
        changes.map((change) =>
          expect(change()).rejects.toBeInstanceOf(ForbiddenError)
        )
      );
    })
  );
});

test("lead must be an agent member, replaces previous lead and clears on removal", async () => {
  seedTeam("t1");
  await service.addMember(user, member("t1"));
  await service.addMember(user, member("t1", "a2"));
  await service.addMember(user, {
    memberId: "u1",
    memberKind: "user",
    teamId: "t1",
  });
  await Promise.all(
    ["absent", "u1"].map((agentId) =>
      expect(
        service.setLead(user, { agentId, teamId: "t1" })
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
  await service.setLead(user, { agentId: "a1", teamId: "t1" });
  expect(
    (await service.setLead(user, { agentId: "a2", teamId: "t1" })).leadAgentId
  ).toBe("a2");
  expect(
    (await service.removeMember(user, memberRef("t1", "a2"))).leadAgentId
  ).toBeNull();
  await service.setLead(user, { agentId: "a1", teamId: "t1" });
  expect(
    (await service.setLead(user, { agentId: null, teamId: "t1" })).leadAgentId
  ).toBeNull();
  await expect(
    service.removeMember(user, memberRef("t1", "a2"))
  ).rejects.toMatchObject({ code: "not_found" });
});

test("agents have one home across teams; moves and removal promote live lowest id", async () => {
  for (const id of ["first", "a-archived", "b-live", "c-live"]) {
    seedTeam(id);
  }
  expect((await service.addMember(user, member("first"))).isHome).toBe(true);
  expect((await service.addMember(user, member("b-live"))).isHome).toBe(false);
  await service.addMember(user, member("c-live"));
  await service.addMember(user, member("a-archived"));
  await service.archive(user, "a-archived");
  expect(
    (await service.addMember(user, member("c-live", "a1", true))).isHome
  ).toBe(true);
  expect((await service.get(user, "first")).members[0]?.isHome).toBe(false);
  await service.removeMember(user, memberRef("c-live"));
  expect((await service.get(user, "b-live")).members[0]?.isHome).toBe(true);
  await service.removeMember(user, memberRef("b-live"));
  expect((await service.get(user, "first")).members[0]?.isHome).toBe(true);
  await service.removeMember(user, memberRef("first"));
  expect((await service.get(user, "a-archived")).members[0]?.isHome).toBe(true);
  expect(
    (
      await service.addMember(user, {
        isHome: true,
        memberId: "u1",
        memberKind: "user",
        teamId: "c-live",
      })
    ).isHome
  ).toBe(false);
});

test("membership and folder grants are idempotent and removed together; no folder gets no grant", async () => {
  const team = await service.create(user, { name: "Ops" });
  await service.addMember(user, member(team.id));
  await service.addMember(user, member(team.id));
  expect((await service.get(user, team.id)).members).toHaveLength(1);
  expect(grants()).toHaveLength(1);
  await service.removeMember(user, memberRef(team.id));
  expect(grants()).toEqual([]);
  seedTeam("everyone", { folderPath: null });
  await service.addMember(user, member("everyone"));
  expect(grants()).toEqual([]);
});

test("agents must belong to workspace and be active; failed create leaves no folders", async () => {
  await Promise.all(
    ["missing", "foreign", "old"].map((memberId) =>
      expect(
        service.create(user, { leadAgentId: memberId, name: "No" })
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
  seedTeam("t1");
  await Promise.all(
    ["missing", "foreign", "old"].map((memberId) =>
      expect(
        service.addMember(user, member("t1", memberId))
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
  expect(db.select().from(libraryEntries).all()).toEqual([]);
});

test("profile handles are workspace unique and self-set is idempotent", async () => {
  expect(await service.profiles.get(user, {})).toBeNull();
  const profile = { handle: "dom-f", name: "Dom", userId: "u1" };
  expect(await service.profiles.set(user, profileInput("dom-f"))).toEqual(
    profile
  );
  expect(await service.profiles.set(user, profileInput("dom-f"))).toEqual(
    profile
  );
  expect(await service.profiles.get(other, { userId: "u1" })).toEqual(profile);
  await expect(
    service.profiles.set(other, profileInput("dom-f"))
  ).rejects.toMatchObject({ code: "conflict" });
  await service.profiles.set(
    { ...user, workspaceId: "w2" },
    profileInput("dom-f")
  );
  await Promise.all(
    [
      { ...user, apiKey: { access: "read" as const, id: "key" } },
      { ...user, oauthClient: { access: "read" as const, clientId: "client" } },
    ].flatMap((principal) => [
      expect(
        service.profiles.set(principal, profileInput("new-handle"))
      ).rejects.toBeInstanceOf(ForbiddenError),
      expect(service.create(principal, { name: "No" })).rejects.toBeInstanceOf(
        ForbiddenError
      ),
    ])
  );
  await expect(service.profiles.get(system, {})).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("update preserves absent fields; rules replace; archive is idempotent and blocks changes", async () => {
  const team = await service.create(user, {
    leadAgentId: "a1",
    name: "Ops",
    rules: "old",
  });
  expect(await service.update(user, { teamId: team.id })).toEqual(team);
  expect(
    await service.update(user, { leadListens: false, teamId: team.id })
  ).toMatchObject({ leadListens: false, name: "Ops" });
  expect(
    (await service.setRules(user, { rules: "new", teamId: team.id })).rules
  ).toBe("new");
  const archived = await service.archive(user, team.id);
  expect(archived.archivedAt).toBe(NOW);
  expect(await service.archive(user, team.id)).toEqual(archived);
  expect(grants()).toHaveLength(1);
  expect(archived.members).toHaveLength(1);
  await Promise.all(
    [
      () => service.update(user, { name: "No", teamId: team.id }),
      () => service.addMember(user, member(team.id, "a2")),
      () => service.setLead(user, { agentId: null, teamId: team.id }),
      () => service.setRules(user, { rules: "", teamId: team.id }),
    ].map((change) =>
      expect(change()).rejects.toMatchObject({ code: "invalid" })
    )
  );
  await service.removeMember(user, memberRef(team.id));
  expect(grants()).toHaveLength(0);
  seedTeam("everyone");
  await expect(service.archive(admin, "everyone")).rejects.toMatchObject({
    code: "invalid",
  });
});

test("concurrent handle claims map the unique-index race to conflict", async () => {
  const results = await Promise.allSettled([
    service.profiles.set(user, profileInput("same-handle")),
    service.profiles.set(other, profileInput("same-handle")),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "conflict" },
  });
});

test("concurrent joins keep exactly one home and allow a lead in another team", async () => {
  seedTeam("one");
  seedTeam("two");
  await Promise.all([
    service.addMember(user, member("one")),
    service.addMember(user, member("two")),
  ]);
  const all = await service.list(user);
  expect(
    all.flatMap((entry) => entry.members).filter((row) => row.isHome)
  ).toHaveLength(1);
  const team = await service.create(user, { leadAgentId: "a1", name: "Third" });
  expect(team.members).toEqual([member(team.id)]);
});

test("a failed grant rolls back team creation, folders, membership and home changes", async () => {
  seedTeam("original");
  await service.addMember(user, member("original"));
  db.client.exec(`CREATE TRIGGER fail_grant BEFORE INSERT ON agent_library_access
    BEGIN SELECT RAISE(ABORT, 'grant unavailable'); END`);
  await expect(
    service.create(user, { leadAgentId: "a1", name: "Ops" })
  ).rejects.toThrow();
  expect((await service.list(user)).map((team) => team.id)).toEqual([
    "original",
  ]);
  expect((await service.get(user, "original")).members).toEqual([
    member("original", "a1", true),
  ]);
  expect(db.select().from(libraryEntries).all()).toEqual([]);
  expect(grants()).toEqual([]);
});

test("explicit null owner is admin-only; invalid derived slugs and folder files are invalid", async () => {
  await expect(
    service.create(user, { name: "Ops", ownerUserId: null })
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    (await service.create(admin, { name: "Ops", ownerUserId: null }))
      .ownerUserId
  ).toBeNull();
  await expect(service.create(user, { name: "!!!" })).rejects.toMatchObject({
    code: "invalid",
  });
  db.insert(libraryEntries)
    .values({
      etag: "etag",
      kind: "file",
      mtime: NOW,
      parent: "teams",
      path: "teams/blocked",
      size: 1,
      updatedById: "u1",
      updatedByKind: "user",
      workspaceId: WORKSPACE,
    })
    .run();
  await expect(service.create(user, { name: "Blocked" })).rejects.toMatchObject(
    { code: "invalid" }
  );
});

test("slack link parses a team, a Slack workspace and a channel", () => {
  const input = { channelId: "C1", slackTeamId: "T1", teamId: "t1" };
  expect(slackLinkInputSchema.parse(input)).toStrictEqual(input);
  expect(
    slackLinkInputSchema.safeParse({ channelId: "C1", teamId: "t1" }).success
  ).toBe(false);
  expect(slackLinkInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(
    false
  );
});

test("stub slack.link, slack.unlink and slack.status reject with not_found for a user", async () => {
  await expect(
    service.slack.link(user, {
      channelId: "C1",
      slackTeamId: "T1",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(service.slack.unlink(user, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.slack.status(user, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub slack calls throw ForbiddenError for the system principal", () => {
  expect(() => service.slack.status(system, "t1")).toThrow(ForbiddenError);
  expect(() => service.slack.unlink(system, "t1")).toThrow(ForbiddenError);
});
