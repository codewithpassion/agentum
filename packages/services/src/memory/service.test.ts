import { expect, test } from "bun:test";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  MEMORY_NOTE_MAX_CHARS,
} from "@repo/db/shared";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";
import {
  addInputSchema,
  createMemoryService,
  decideInputSchema,
  rulesSetInputSchema,
} from "./service.ts";

const WORKSPACE = "w1";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

const agentId = "agent_1";
const addInput = {
  agentId,
  kind: "people",
  text: "Prefers short replies",
} as const;

test("list and changes return nothing for a workspace with no memory", async () => {
  const service = createMemoryService();

  expect(await service.list(user, { agentId })).toEqual([]);
  expect(await service.changes(user, { agentId })).toEqual([]);
});

test("rules.get returns the default rules, and each call gets its own copy", async () => {
  const service = createMemoryService();

  const first = await service.rules.get(user, { agentId });
  expect(first).toEqual({
    agent: DEFAULT_REMEMBER_RULES,
    workspaceNever: [...DEFAULT_NEVER_REMEMBER],
  });

  first.agent.remember.push("mutated");
  first.workspaceNever.push("mutated");
  const second = await service.rules.get(user, { agentId });
  expect(second).toEqual({
    agent: DEFAULT_REMEMBER_RULES,
    workspaceNever: [...DEFAULT_NEVER_REMEMBER],
  });
});

test("writes find no note, change or agent to act on", async () => {
  const service = createMemoryService();

  await expect(service.add(user, addInput)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.edit(user, { agentId, noteId: "note_1", text: "Changed" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.forget(user, { agentId, noteId: "note_1" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.decide(user, { changeId: "change_1", decision: "approve" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(service.undo(user, "change_1")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.rules.set(user, { agentId, rules: DEFAULT_REMEMBER_RULES })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("every method throws ForbiddenError for the system principal", () => {
  const service = createMemoryService();
  const rules = { agentId, rules: DEFAULT_REMEMBER_RULES };
  const calls = [
    () => service.list(system, { agentId }),
    () => service.changes(system, { agentId }),
    () => service.add(system, addInput),
    () => service.edit(system, { agentId, noteId: "note_1", text: "x" }),
    () => service.forget(system, { agentId, noteId: "note_1" }),
    () => service.decide(system, { changeId: "c", decision: "approve" }),
    () => service.undo(system, "c"),
    () => service.rules.get(system, { agentId }),
    () => service.rules.set(system, rules),
  ];

  for (const call of calls) {
    expect(call).toThrow(ForbiddenError);
  }
});

test("addInputSchema accepts a valid note and refuses bad ones", () => {
  expect(addInputSchema.safeParse(addInput).success).toBe(true);
  expect(
    addInputSchema.safeParse({
      ...addInput,
      source: { id: "run_1", kind: "run" },
    }).success
  ).toBe(true);

  const tooLong = "x".repeat(MEMORY_NOTE_MAX_CHARS + 1);
  expect(addInputSchema.safeParse({ ...addInput, text: tooLong }).success).toBe(
    false
  );
  expect(addInputSchema.safeParse({ ...addInput, text: "" }).success).toBe(
    false
  );
  expect(addInputSchema.safeParse({ ...addInput, text: "  " }).success).toBe(
    false
  );
  expect(
    addInputSchema.safeParse({ ...addInput, kind: "gossip" }).success
  ).toBe(false);
  expect(addInputSchema.safeParse({ ...addInput, extra: true }).success).toBe(
    false
  );
});

test("rulesSetInputSchema accepts the defaults and refuses unknown values", () => {
  expect(
    rulesSetInputSchema.safeParse({ agentId, rules: DEFAULT_REMEMBER_RULES })
      .success
  ).toBe(true);

  const rules = (overrides: Record<string, unknown>) =>
    rulesSetInputSchema.safeParse({
      agentId,
      rules: { ...DEFAULT_REMEMBER_RULES, ...overrides },
    }).success;

  expect(rules({ learnLevel: "always" })).toBe(false);
  expect(rules({ dreamSchedule: "daily" })).toBe(false);
});

test("decideInputSchema refuses a decision other than approve or reject", () => {
  expect(
    decideInputSchema.safeParse({ changeId: "c1", decision: "approve" }).success
  ).toBe(true);
  expect(
    decideInputSchema.safeParse({ changeId: "c1", decision: "reject" }).success
  ).toBe(true);
  expect(
    decideInputSchema.safeParse({ changeId: "c1", decision: "undo" }).success
  ).toBe(false);
});
