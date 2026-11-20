import { expect, test } from "bun:test";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";
import { listTeamInputSchema } from "./service.ts";
import { makeWorld, person, USER_A } from "./test-world.ts";

const system: Principal = { kind: "system" };

test("team list input accepts a team id, with or without a kind", () => {
  expect(listTeamInputSchema.safeParse({ teamId: "t1" }).success).toBe(true);
  expect(
    listTeamInputSchema.safeParse({ kind: "people", teamId: "t1" }).success
  ).toBe(true);
});

test("team list input rejects an empty team id and an unknown key", () => {
  expect(listTeamInputSchema.safeParse({ teamId: "" }).success).toBe(false);
  expect(
    listTeamInputSchema.safeParse({ extra: true, teamId: "t1" }).success
  ).toBe(false);
});

test("stub listTeam resolves to no notes for a user", async () => {
  const { service } = makeWorld();
  expect(await service.listTeam(person(USER_A), { teamId: "t1" })).toEqual([]);
});

test("listTeam throws ForbiddenError for the system principal", () => {
  const { service } = makeWorld();
  expect(() => service.listTeam(system, { teamId: "t1" })).toThrow(
    ForbiddenError
  );
});

test("a held team change is not decided or undone through the agent paths", async () => {
  const { db, service } = makeWorld();
  db.client.run(
    "INSERT INTO teams (created_at, id, name, rules, slug, workspace_id) VALUES ('2026-01-01T00:00:00.000Z', 't1', 't1', '', 't1', 'w1')"
  );
  db.client.run(
    "INSERT INTO memory_changes (id, workspace_id, team_id, action, created_at, kind, note_id, status, text, written_by) VALUES ('c1', 'w1', 't1', 'add', '2026-01-01T00:00:00.000Z', 'work', 'n1', 'held', 'text', 'dream')"
  );
  await Promise.all(
    (["approve", "reject"] as const).map((decision) =>
      expect(
        service.decide(person(USER_A), { changeId: "c1", decision })
      ).rejects.toMatchObject({ code: "invalid" })
    )
  );
});
