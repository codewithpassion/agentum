import { expect, test } from "bun:test";
import { ForbiddenError } from "./authz.ts";
import { makeDreamWorld } from "./dream/test-dream.ts";
import {
  dreamAgentInputSchema,
  dreamAnswerInputSchema,
  dreamDecideInputSchema,
  dreamRunIdInputSchema,
  dreamTeamInputSchema,
} from "./dream.ts";
import { OWNER, person } from "./memory/test-world.ts";
import type { Principal } from "./workspaces.ts";

const system: Principal = { kind: "system" };
const member = person("user_member");

const makeService = () => makeDreamWorld().dream;

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

test("a run, a change list or a question that does not exist reads as missing", async () => {
  const service = makeService();
  const owner = person(OWNER, { isAdmin: true });
  await expect(service.get(owner, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.changes(owner, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.undo(owner, "d1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.decide(owner, { decision: "approve", dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.answer(owner, { noteId: "n1", questionId: "q1" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("an agent that has not dreamed has no runs, and an unknown agent cannot start one", async () => {
  const service = makeService();
  expect(await service.list(member, "agent_scout")).toEqual([]);
  await expect(
    service.runNow(person(OWNER, { isAdmin: true }), "nope")
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a person who is neither the owner nor an admin cannot start a dream", async () => {
  await expect(
    makeService().runNow(member, "agent_scout")
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("the team dream is a stub until TX.2", async () => {
  await expect(makeService().runTeamNow(member, "t1")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("every method refuses the system principal, except the tick's own", async () => {
  const service = makeService();
  const refused = [
    service.list(system, "a1"),
    service.get(system, "d1"),
    service.runNow(system, "a1"),
    Promise.resolve().then(() => service.runTeamNow(system, "t1")),
    service.undo(system, "d1"),
    service.changes(system, "d1"),
    service.decide(system, { decision: "reject", dreamRunId: "d1" }),
    service.answer(system, { noteId: "n1", questionId: "q1" }),
  ];
  for (const call of refused) {
    // biome-ignore lint/performance/noAwaitInLoops: each call is awaited on its own
    await expect(call).rejects.toBeInstanceOf(ForbiddenError);
  }
});
