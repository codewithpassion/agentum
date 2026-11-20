import { expect, test } from "bun:test";
import { memoryChanges } from "@repo/db/schema/memory";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  MEMORY_NOTE_MAX_CHARS,
  type RememberRules,
} from "@repo/db/shared";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";
import {
  addInputSchema,
  decideInputSchema,
  rulesSetInputSchema,
} from "./service.ts";
import {
  AGENT,
  errorOf,
  makeWorld,
  OTHER_AGENT,
  OWNER,
  person,
  RUN,
  run,
  USER_A,
  WORKSPACE,
} from "./test-world.ts";

const system: Principal = { kind: "system" };
const addInput = {
  agentId: AGENT,
  kind: "people",
  text: "Prefers short replies",
} as const;

test("every method refuses the system principal", async () => {
  const { service } = makeWorld();
  const calls = [
    () => service.list(system, { agentId: AGENT }),
    () => service.changes(system, { agentId: AGENT }),
    () => service.add(system, addInput),
    () => service.edit(system, { agentId: AGENT, noteId: "n", text: "x" }),
    () => service.forget(system, { agentId: AGENT, noteId: "n" }),
    () => service.decide(system, { changeId: "c", decision: "approve" }),
    () => service.undo(system, "c"),
    () => service.rules.get(system, { agentId: AGENT }),
    () =>
      service.rules.set(system, {
        agentId: AGENT,
        rules: DEFAULT_REMEMBER_RULES,
      }),
  ];
  const errors = await Promise.all(calls.map((call) => errorOf(call())));
  for (const error of errors) {
    expect(error).toBeInstanceOf(ForbiddenError);
  }
});

test("machines, triggers and peers never touch memory", async () => {
  const { service } = makeWorld();
  const others: Principal[] = [
    { kind: "machine", machineId: "m1", workspaceId: WORKSPACE },
    {
      agentId: AGENT,
      kind: "trigger",
      triggerId: "t1",
      workspaceId: WORKSPACE,
    },
    {
      agentId: AGENT,
      connectionId: "c1",
      kind: "peer",
      workspaceId: WORKSPACE,
    },
  ];
  const errors = await Promise.all(
    others.flatMap((principal) => [
      errorOf(service.list(principal, { agentId: AGENT })),
      errorOf(service.add(principal, addInput)),
    ])
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ForbiddenError);
  }
});

test("a run reaches only its own agent's memory", async () => {
  const { service } = makeWorld();
  const stranger = run(RUN.ui, OTHER_AGENT);

  expect(
    await errorOf(service.list(stranger, { agentId: AGENT }))
  ).toBeInstanceOf(ForbiddenError);
  expect(await errorOf(service.add(stranger, addInput))).toBeInstanceOf(
    ForbiddenError
  );
});

test("a read-only key reads memory and cannot write it", async () => {
  const { service } = makeWorld();
  const reader = person(USER_A, {
    apiKey: { access: "read", id: "k1" },
    via: "api_key",
  });

  expect(await service.list(reader, { agentId: AGENT })).toEqual([]);
  expect(await errorOf(service.add(reader, addInput))).toBeInstanceOf(
    ForbiddenError
  );
});

test("an unknown agent is not found", async () => {
  const { service } = makeWorld();

  expect(
    await errorOf(service.list(person(USER_A), { agentId: "nope" }))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(service.add(person(USER_A), { ...addInput, agentId: "nope" }))
  ).toMatchObject({ code: "not_found" });
});

test("a dry run writes nothing", async () => {
  const { db, service } = makeWorld();

  expect(
    await errorOf(service.add(run(RUN.ui, AGENT, { dryRun: true }), addInput))
  ).toBeInstanceOf(ForbiddenError);
  expect(db.select().from(memoryChanges).all()).toEqual([]);
});

test("rules.get returns the defaults, and each call gets its own copy", async () => {
  const { service } = makeWorld();

  const first = await service.rules.get(person(USER_A), { agentId: AGENT });
  expect(first).toEqual({
    agent: DEFAULT_REMEMBER_RULES,
    workspaceNever: [...DEFAULT_NEVER_REMEMBER],
  });
  first.agent.remember.push("mutated");
  first.workspaceNever.push("mutated");
  expect(await service.rules.get(person(USER_A), { agentId: AGENT })).toEqual({
    agent: DEFAULT_REMEMBER_RULES,
    workspaceNever: [...DEFAULT_NEVER_REMEMBER],
  });
});

test("rules.get reads the workspace never list", async () => {
  const { db, service } = makeWorld();
  db.update(workspaces)
    .set({ neverRemember: JSON.stringify(["Salaries"]) })
    .where(eq(workspaces.id, WORKSPACE))
    .run();

  const rules = await service.rules.get(person(USER_A), { agentId: AGENT });
  expect(rules.workspaceNever).toEqual(["Salaries"]);
});

const stricter: RememberRules = {
  dreamSchedule: "weekly",
  learnLevel: "ask_first",
  never: ["Salaries"],
  remember: ["Who prefers which channel"],
  shareWithTeam: false,
};

test("rules.set works for an org admin and for the agent's owner, on a browser session", async () => {
  const { service } = makeWorld();

  await service.rules.set(person("user_admin", { isAdmin: true }), {
    agentId: AGENT,
    rules: stricter,
  });
  expect(
    (await service.rules.get(person(USER_A), { agentId: AGENT })).agent
  ).toEqual(stricter);

  await service.rules.set(person(OWNER), {
    agentId: AGENT,
    rules: DEFAULT_REMEMBER_RULES,
  });
  expect(
    (await service.rules.get(person(USER_A), { agentId: AGENT })).agent
  ).toEqual(DEFAULT_REMEMBER_RULES);
});

test("rules.set refuses a member who is neither owner nor admin", async () => {
  const { service } = makeWorld();

  expect(
    await errorOf(
      service.rules.set(person(USER_A), { agentId: AGENT, rules: stricter })
    )
  ).toBeInstanceOf(ForbiddenError);
});

test("rules.set refuses an API key, an app, a run and a peer, even for the owner", async () => {
  const { service } = makeWorld();
  const callers: Principal[] = [
    person(OWNER, { apiKey: { access: "write", id: "k1" }, via: "api_key" }),
    person(OWNER, {
      oauthClient: { access: "write", clientId: "c1" },
      via: "oauth",
    }),
    person(OWNER, { isAdmin: true, via: "slack" }),
    run(RUN.ui),
    {
      agentId: AGENT,
      connectionId: "c1",
      kind: "peer",
      workspaceId: WORKSPACE,
    },
  ];
  const errors = await Promise.all(
    callers.map((caller) =>
      errorOf(service.rules.set(caller, { agentId: AGENT, rules: stricter }))
    )
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ForbiddenError);
  }
  expect(
    (await service.rules.get(person(USER_A), { agentId: AGENT })).agent
  ).toEqual(DEFAULT_REMEMBER_RULES);
});

test("rules.set on another workspace's agent finds nothing", async () => {
  const { service } = makeWorld();

  expect(
    await errorOf(
      service.rules.set(person(OWNER, { isAdmin: true, workspaceId: "w2" }), {
        agentId: AGENT,
        rules: stricter,
      })
    )
  ).toMatchObject({ code: "not_found" });
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
    rulesSetInputSchema.safeParse({
      agentId: AGENT,
      rules: DEFAULT_REMEMBER_RULES,
    }).success
  ).toBe(true);

  const rules = (overrides: Record<string, unknown>) =>
    rulesSetInputSchema.safeParse({
      agentId: AGENT,
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

test("addInputSchema turns line breaks into one space and counts after that", () => {
  const parsed = addInputSchema.parse({
    ...addInput,
    text: "  Mia wants\n\ndrafts as\tGoogle Docs  ",
  });
  expect(parsed.text).toBe("Mia wants drafts as Google Docs");

  const spaced = `${"a".repeat(MEMORY_NOTE_MAX_CHARS - 2)}\n\n\n\nb`;
  expect(addInputSchema.safeParse({ ...addInput, text: spaced }).success).toBe(
    true
  );
  expect(
    addInputSchema.safeParse({ ...addInput, text: " \n\t " }).success
  ).toBe(false);
});
