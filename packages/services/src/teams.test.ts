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
    db.insert(workspaces).values({
      clerkOrgId: id, createdAt: NOW, id, name: id, timezone: "UTC",
    }).run();
  }
  for (const [id, workspaceId, status] of [
    ["a1", WORKSPACE, "active"], ["a2", WORKSPACE, "active"],
    ["old", WORKSPACE, "archived"], ["foreign", "w2", "active"],
  ]) {
    db.insert(agents).values({
      createdAt: NOW, createdBy: "u1", id, instructions: "", model: "m",
      name: id, runtime: "fake", runtimeConfig: "{}", slug: id,
      status, workspaceId,
    }).run();
  }
  service = createTeamsService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(NOW), sleep: () => Promise.resolve() },
    db,
  });
});

const member = (teamId: string, memberId = "a1", isHome = false) => ({
  isHome, memberId, memberKind: "agent" as const, teamId,
});
const seedTeam = (id: string, values: Partial<typeof teams.$inferInsert> = {}) => {
  db.insert(teams).values({
    createdAt: NOW, id, name: id, ownerUserId: "u1", slug: id,
    workspaceId: WORKSPACE, ...values,
  }).run();
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
  const member = { memberId: "m1", teamId: "t1" };
  expect(
    teamMemberInputSchema.safeParse({ ...member, memberKind: "robot" }).success
  ).toBe(false);
  expect(
    teamMemberInputSchema.safeParse({ ...member, memberKind: "agent" }).success
  ).toBe(true);
  expect(
    teamMemberInputSchema.safeParse({ ...member, memberKind: "user" }).success
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
  const team = await service.create(user, { name: "  Ops Team ", leadAgentId: "a1" });
  expect(team).toMatchObject({
    archivedAt: null, createdAt: NOW, folderPath: "teams/ops-team",
    leadAgentId: "a1", leadListens: true, name: "Ops Team",
    ownerUserId: "u1", rules: "", slug: "ops-team",
    members: [member(team.id, "a1", true)],
  });
  expect(db.select().from(libraryEntries).all()).toEqual([
    { etag: null, kind: "dir", mtime: NOW, parent: "", path: "teams",
      size: 0, updatedById: "u1", updatedByKind: "user", workspaceId: WORKSPACE },
    { etag: null, kind: "dir", mtime: NOW, parent: "teams", path: "teams/ops-team",
      size: 0, updatedById: "u1", updatedByKind: "user", workspaceId: WORKSPACE },
  ]);
  expect(grants()).toMatchObject([{ agentId: "a1", mode: "write", path: team.folderPath }]);
  await service.create(user, { name: "Second" });
  expect(db.select().from(libraryEntries).all()).toHaveLength(3);
  await expect(service.create(user, { name: "Ops Team" })).rejects.toMatchObject({ code: "conflict" });
});

test("reads are workspace scoped, live ordered by name then id, with members", async () => {
  seedTeam("z", { name: "Same" }); seedTeam("a", { name: "Same" });
  seedTeam("b", { name: "Alpha" }); seedTeam("archived", { archivedAt: NOW });
  seedTeam("foreign", { workspaceId: "w2" });
  await service.addMember(user, member("a"));
  expect((await service.list(other)).map(t => t.id)).toEqual(["b", "a", "z"]);
  expect((await service.get(other, "a")).members).toEqual([member("a", "a1", true)]);
  expect((await service.get(user, "archived")).archivedAt).toBe(NOW);
  await expect(service.get(user, "foreign")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.update(user, { teamId: "foreign", name: "X" })).rejects.toMatchObject({ code: "not_found" });
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});

test("owners and admins write; other users and read-only credentials cannot write", async () => {
  seedTeam("t1");
  await service.update(user, { teamId: "t1", name: "Owner" });
  await service.update(admin, { teamId: "t1", ownerUserId: "u2" });
  await expect(service.update(user, { teamId: "t1", name: "No" })).rejects.toBeInstanceOf(ForbiddenError);
  await expect(service.create(user, { name: "No", ownerUserId: "u2" })).rejects.toBeInstanceOf(ForbiddenError);
  await service.create(admin, { name: "Admin", ownerUserId: "u2" });
  await service.update(other, { teamId: "t1", name: "New owner" });
  for (const denied of [
    user,
    { ...other, apiKey: { access: "read" as const, id: "key" }, via: "api_key" as const },
    { ...other, oauthClient: { access: "read" as const, id: "client" }, via: "oauth" as const },
  ]) {
    const changes = [
      () => service.update(denied, { teamId: "t1", name: "No" }),
      () => service.archive(denied, "t1"),
      () => service.addMember(denied, member("t1")),
      () => service.removeMember(denied, member("t1")),
      () => service.setLead(denied, { teamId: "t1", agentId: null }),
      () => service.setRules(denied, { teamId: "t1", rules: "" }),
    ];
    for (const change of changes) {
      await expect(change()).rejects.toBeInstanceOf(ForbiddenError);
    }
  }
});

test("lead must be an agent member, replaces previous lead and clears on removal", async () => {
  seedTeam("t1");
  await service.addMember(user, member("t1"));
  await service.addMember(user, member("t1", "a2"));
  await service.addMember(user, { teamId: "t1", memberId: "u1", memberKind: "user" });
  for (const agentId of ["absent", "u1"]) {
    await expect(service.setLead(user, { teamId: "t1", agentId })).rejects.toMatchObject({ code: "invalid" });
  }
  await service.setLead(user, { teamId: "t1", agentId: "a1" });
  expect((await service.setLead(user, { teamId: "t1", agentId: "a2" })).leadAgentId).toBe("a2");
  expect((await service.removeMember(user, member("t1", "a2"))).leadAgentId).toBeNull();
  await service.setLead(user, { teamId: "t1", agentId: "a1" });
  expect((await service.setLead(user, { teamId: "t1", agentId: null })).leadAgentId).toBeNull();
  await expect(service.removeMember(user, member("t1", "a2"))).rejects.toMatchObject({ code: "not_found" });
});

test("agents have one home across teams; moves and removal promote live lowest id", async () => {
  for (const id of ["first", "a-archived", "b-live", "c-live"]) { seedTeam(id); }
  expect((await service.addMember(user, member("first"))).isHome).toBe(true);
  expect((await service.addMember(user, member("b-live"))).isHome).toBe(false);
  await service.addMember(user, member("c-live"));
  await service.addMember(user, member("a-archived"));
  await service.archive(user, "a-archived");
  expect((await service.addMember(user, member("c-live", "a1", true))).isHome).toBe(true);
  expect((await service.get(user, "first")).members[0]?.isHome).toBe(false);
  await service.removeMember(user, member("c-live"));
  expect((await service.get(user, "b-live")).members[0]?.isHome).toBe(true);
  await service.removeMember(user, member("b-live"));
  expect((await service.get(user, "first")).members[0]?.isHome).toBe(true);
  await service.removeMember(user, member("first"));
  expect((await service.get(user, "a-archived")).members[0]?.isHome).toBe(true);
  expect((await service.addMember(user, {
    teamId: "c-live", memberId: "u1", memberKind: "user", isHome: true,
  })).isHome).toBe(false);
});

test("membership and folder grants are idempotent and removed together; no folder gets no grant", async () => {
  const team = await service.create(user, { name: "Ops" });
  await service.addMember(user, member(team.id));
  await service.addMember(user, member(team.id));
  expect((await service.get(user, team.id)).members).toHaveLength(1);
  expect(grants()).toHaveLength(1);
  await service.removeMember(user, member(team.id));
  expect(grants()).toEqual([]);
  seedTeam("everyone", { folderPath: null });
  await service.addMember(user, member("everyone"));
  expect(grants()).toEqual([]);
});

test("agents must belong to workspace and be active; failed create leaves no folders", async () => {
  for (const memberId of ["missing", "foreign", "old"]) {
    await expect(service.create(user, { name: "No", leadAgentId: memberId })).rejects.toMatchObject({ code: "invalid" });
  }
  seedTeam("t1");
  for (const memberId of ["missing", "foreign", "old"]) {
    await expect(service.addMember(user, member("t1", memberId))).rejects.toMatchObject({ code: "invalid" });
  }
  expect(db.select().from(libraryEntries).all()).toEqual([]);
});

test("profile handles are workspace unique and self-set is idempotent", async () => {
  expect(await service.profiles.get(user, {})).toBeNull();
  const profile = { handle: "dom-f", name: "Dom", userId: "u1" };
  expect(await service.profiles.set(user, profileInput("dom-f"))).toEqual(profile);
  expect(await service.profiles.set(user, profileInput("dom-f"))).toEqual(profile);
  expect(await service.profiles.get(other, { userId: "u1" })).toEqual(profile);
  await expect(service.profiles.set(other, profileInput("dom-f"))).rejects.toMatchObject({ code: "conflict" });
  await service.profiles.set({ ...user, workspaceId: "w2" }, profileInput("dom-f"));
  for (const principal of [
    { ...user, apiKey: { access: "read" as const, id: "key" } },
    { ...user, oauthClient: { access: "read" as const, id: "client" } },
  ]) {
    await expect(service.profiles.set(principal, profileInput("new-handle"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.create(principal, { name: "No" })).rejects.toBeInstanceOf(ForbiddenError);
  }
  await expect(service.profiles.get(system, {})).rejects.toBeInstanceOf(ForbiddenError);
});

test("update preserves absent fields; rules replace; archive is idempotent and blocks changes", async () => {
  const team = await service.create(user, { name: "Ops", leadAgentId: "a1", rules: "old" });
  expect(await service.update(user, { teamId: team.id })).toEqual(team);
  expect(await service.update(user, { teamId: team.id, leadListens: false })).toMatchObject({ name: "Ops", leadListens: false });
  expect((await service.setRules(user, { teamId: team.id, rules: "new" })).rules).toBe("new");
  const archived = await service.archive(user, team.id);
  expect(archived.archivedAt).toBe(NOW);
  expect(await service.archive(user, team.id)).toEqual(archived);
  expect(grants()).toHaveLength(1);
  expect(archived.members).toHaveLength(1);
  for (const change of [
    () => service.update(user, { teamId: team.id, name: "No" }),
    () => service.addMember(user, member(team.id, "a2")),
    () => service.removeMember(user, member(team.id)),
    () => service.setLead(user, { teamId: team.id, agentId: null }),
    () => service.setRules(user, { teamId: team.id, rules: "" }),
  ]) {
    await expect(change()).rejects.toMatchObject({ code: "invalid" });
  }
  seedTeam("everyone");
  await expect(service.archive(admin, "everyone")).rejects.toMatchObject({ code: "invalid" });
});
