import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import {
  createDreamService,
  dreamAgentInputSchema,
  dreamAnswerInputSchema,
  dreamDecideInputSchema,
  dreamRunIdInputSchema,
  dreamTeamInputSchema,
} from "./dream.ts";
import { ServiceError } from "./errors.ts";
import { systemClock } from "./runs/types.ts";
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
  return createDreamService({
    atomic: sqliteAtomic(db),
    clock: systemClock,
    db,
  });
};

test("agent input accepts a valid id and rejects an empty id and an unknown key", () => {
  expect(dreamAgentInputSchema.safeParse({ agentId: "a1" }).success).toBe(true);
  expect(dreamAgentInputSchema.safeParse({ agentId: "" }).success).toBe(false);
  expect(
    dreamAgentInputSchema.safeParse({ agentId: "a1", extra: true }).success
  ).toBe(false);
});

test("run id input accepts a valid id and rejects an empty id and an unknown key", () => {
  expect(dreamRunIdInputSchema.safeParse({ dreamRunId: "d1" }).success).toBe(
    true
  );
  expect(dreamRunIdInputSchema.safeParse({ dreamRunId: "" }).success).toBe(
    false
  );
  expect(
    dreamRunIdInputSchema.safeParse({ dreamRunId: "d1", extra: true }).success
  ).toBe(false);
});

test("team input accepts a valid id and rejects an empty id and an unknown key", () => {
  expect(dreamTeamInputSchema.safeParse({ teamId: "t1" }).success).toBe(true);
  expect(dreamTeamInputSchema.safeParse({ teamId: "" }).success).toBe(false);
  expect(
    dreamTeamInputSchema.safeParse({ extra: true, teamId: "t1" }).success
  ).toBe(false);
});

test("answer input needs a question id and a note id", () => {
  expect(
    dreamAnswerInputSchema.safeParse({ noteId: "n1", questionId: "q1" }).success
  ).toBe(true);
  expect(dreamAnswerInputSchema.safeParse({ questionId: "q1" }).success).toBe(
    false
  );
  expect(
    dreamAnswerInputSchema.safeParse({ noteId: "", questionId: "q1" }).success
  ).toBe(false);
});

test("decide input takes approve or reject and nothing else", () => {
  const input = { decision: "approve", dreamRunId: "d1" };
  expect(dreamDecideInputSchema.safeParse(input).success).toBe(true);
  expect(
    dreamDecideInputSchema.safeParse({ ...input, decision: "reject" }).success
  ).toBe(true);
  expect(
    dreamDecideInputSchema.safeParse({ ...input, decision: "maybe" }).success
  ).toBe(false);
});

test("stub changes, decide and answer reject with not_found for a user", async () => {
  const service = makeService();
  await expect(service.changes(user, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.decide(user, { decision: "approve", dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.answer(user, { noteId: "n1", questionId: "q1" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("stub list resolves to no dream runs for a user", async () => {
  expect(await makeService().list(user, "a1")).toEqual([]);
});

test("stub get rejects with not_found for a user", async () => {
  await expect(makeService().get(user, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub runNow rejects with not_found for a user", async () => {
  await expect(makeService().runNow(user, "a1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub runTeamNow rejects with not_found for a user", async () => {
  await expect(makeService().runTeamNow(user, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub undo rejects with not_found for a user", async () => {
  await expect(makeService().undo(user, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("stub errors are ServiceError instances", async () => {
  await expect(makeService().get(user, "d1")).rejects.toBeInstanceOf(
    ServiceError
  );
});

test("every method throws ForbiddenError for the system principal", () => {
  const service = makeService();
  expect(() => service.list(system, "a1")).toThrow(ForbiddenError);
  expect(() => service.get(system, "d1")).toThrow(ForbiddenError);
  expect(() => service.runNow(system, "a1")).toThrow(ForbiddenError);
  expect(() => service.runTeamNow(system, "t1")).toThrow(ForbiddenError);
  expect(() => service.undo(system, "d1")).toThrow(ForbiddenError);
  expect(() => service.changes(system, "d1")).toThrow(ForbiddenError);
  expect(() =>
    service.decide(system, { decision: "reject", dreamRunId: "d1" })
  ).toThrow(ForbiddenError);
  expect(() =>
    service.answer(system, { noteId: "n1", questionId: "q1" })
  ).toThrow(ForbiddenError);
});
