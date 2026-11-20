import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import { systemClock } from "./runs/types.ts";
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

const makeService = () => {
  const db = migrated();
  return createTeamsService({
    atomic: sqliteAtomic(db),
    clock: systemClock,
    db,
  });
};

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

test("stub list resolves to no teams for a user", async () => {
  expect(await makeService().list(user)).toEqual([]);
});

test("stub get rejects with not_found for a user", async () => {
  await expect(makeService().get(user, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub create rejects with not_found for a user", async () => {
  await expect(
    makeService().create(user, { name: "Ops" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub update rejects with not_found for a user", async () => {
  await expect(
    makeService().update(user, { name: "Ops", teamId: "t1" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub archive rejects with not_found for a user", async () => {
  await expect(makeService().archive(user, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub addMember rejects with not_found for a user", async () => {
  await expect(
    makeService().addMember(user, {
      memberId: "m1",
      memberKind: "agent",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub removeMember rejects with not_found for a user", async () => {
  await expect(
    makeService().removeMember(user, {
      memberId: "m1",
      memberKind: "agent",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub setLead rejects with not_found for a user", async () => {
  await expect(
    makeService().setLead(user, { agentId: null, teamId: "t1" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub setRules rejects with not_found for a user", async () => {
  await expect(
    makeService().setRules(user, { rules: "", teamId: "t1" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub profiles.get resolves to null for a user", async () => {
  expect(await makeService().profiles.get(user, {})).toBeNull();
});

test("stub profiles.set rejects with not_found for a user", async () => {
  await expect(
    makeService().profiles.set(user, profileInput("dom-f"))
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub list throws ForbiddenError for the system principal", () => {
  expect(() => makeService().list(system)).toThrow(ForbiddenError);
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
  const service = makeService();
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
  const service = makeService();
  expect(() => service.slack.status(system, "t1")).toThrow(ForbiddenError);
  expect(() => service.slack.unlink(system, "t1")).toThrow(ForbiddenError);
});
