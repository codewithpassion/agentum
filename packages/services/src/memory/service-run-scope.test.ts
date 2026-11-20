// A run that sees a person's private notes writes to that person's private file.
// The read rule is `privateNotesUserOf` in library/private-notes.ts, and the
// write side asks it too, so a run writes where it reads.
import { expect, test } from "bun:test";
import { memoryChanges } from "@repo/db/schema/memory";
import type { LearnLevel } from "@repo/db/shared";
import {
  AGENT,
  errorOf,
  MEMORY,
  makeWorld,
  OWNER,
  person,
  RUN,
  run,
  SESSION,
  text,
  USER_A,
  USER_B,
  type World,
} from "./test-world.ts";

const ADMIN = person("user_admin", { isAdmin: true });
const note = () =>
  ({
    agentId: AGENT,
    kind: "people",
    text: "Mia wants drafts as Google Docs",
  }) as const;

const setLevel = async (world: World, learnLevel: LearnLevel) => {
  await world.service.rules.set(person(OWNER), {
    agentId: AGENT,
    rules: {
      dreamSchedule: "nightly",
      learnLevel,
      never: [],
      remember: [],
      shareWithTeam: true,
    },
  });
};

const knows = async (world: World, principal: ReturnType<typeof person>) =>
  (await world.service.list(principal, { agentId: AGENT })).map(
    (item) => item.id
  );

const changeIds = async (world: World, principal: ReturnType<typeof person>) =>
  (await world.service.changes(principal, { agentId: AGENT })).map(
    (item) => item.noteId
  );

const readFile = async (
  world: World,
  principal: ReturnType<typeof person>,
  name: string
) => text((await world.library.read(principal, `${MEMORY}/${name}`)).bytes);

/** A session and a run of A's in it, on the same agent. */
const startRun = (
  world: World,
  seed: { id: string; origin: string; private?: boolean; parentRunId?: string }
) => {
  world.seedSession({
    id: `s_${seed.id}`,
    origin: seed.origin,
    private: seed.private,
  });
  world.seedRun({
    id: `r_${seed.id}`,
    onBehalfOfUserId: USER_A,
    parentRunId: seed.parentRunId,
    sessionId: `s_${seed.id}`,
  });
  return run(`r_${seed.id}`);
};

test("a remember from a run in A's own non-private ui session lands in A's private file", async () => {
  const world = makeWorld();

  const change = await world.service.add(run(RUN.ui), note());

  expect(change.userScope).toBe(USER_A);
  expect(await readFile(world, person(USER_A), "private/user_a.md")).toContain(
    `- id: ${change.noteId}`
  );
  expect(
    await errorOf(world.library.read(person(USER_A), `${MEMORY}/people.md`))
  ).toMatchObject({ code: "not_found" });
});

test("B, the owner and an admin do not see it on Knows or in changes", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());
  await setLevel(world, "tell_after");
  const applied = await world.service.add(run(RUN.ui), note());

  // The desk and roster hide a held change by this column, as rail.test.ts pins.
  const rows = world.db.select().from(memoryChanges).all();
  expect(rows.map((row) => row.userScope)).toEqual([USER_A, USER_A]);
  expect(held.userScope).toBe(USER_A);
  expect(await knows(world, person(USER_A))).toEqual([applied.noteId]);
  expect(await changeIds(world, person(USER_A))).toEqual(
    expect.arrayContaining([held.noteId, applied.noteId])
  );
  const others = [person(USER_B), person(OWNER), ADMIN];
  expect(await Promise.all(others.map((other) => knows(world, other)))).toEqual(
    [[], [], []]
  );
  expect(
    await Promise.all(others.map((other) => changeIds(world, other)))
  ).toEqual([[], [], []]);
  const reads = await Promise.all(
    others.map((other) =>
      errorOf(world.library.read(other, `${MEMORY}/private/user_a.md`))
    )
  );
  for (const error of reads) {
    expect(error).toMatchObject({ code: "not_found" });
  }
});

test("a remember from a team room, Slack channel, artifact or Q&A run that A started stays shared", async () => {
  const world = makeWorld();

  for (const origin of ["inbox", "slack", "artifact", "qa"]) {
    const principal = startRun(world, { id: origin, origin });
    // biome-ignore lint/performance/noAwaitInLoops: each origin is checked on its own
    const change = await world.service.add(principal, note());

    expect(change.userScope).toBeNull();
    expect(await knows(world, person(USER_B))).toContain(change.noteId);
  }
});

test("a remember from A's Slack DM still lands in A's private file", async () => {
  const world = makeWorld();
  const principal = startRun(world, {
    id: "dm",
    origin: "slack",
    private: true,
  });

  const change = await world.service.add(principal, note());

  expect(change.userScope).toBe(USER_A);
  expect(await knows(world, person(USER_B))).toEqual([]);
});

test("a hand-off from A's ui session writes to A's file", async () => {
  const world = makeWorld();
  const principal = startRun(world, {
    id: "handoff",
    origin: "mcp",
    parentRunId: RUN.ui,
    private: true,
  });

  const change = await world.service.add(principal, note());

  expect(change.userScope).toBe(USER_A);
  expect(await knows(world, person(USER_B))).toEqual([]);
});

test("a person's own remember from a ui chat stays as the person chose", async () => {
  const world = makeWorld();

  const shared = await world.service.add(person(USER_A), {
    ...note(),
    source: { id: SESSION.ui, kind: "session" },
  });

  expect(shared.userScope).toBeNull();
});

test("a run that sees A's private notes cannot edit a shared note", async () => {
  const world = makeWorld();
  const shared = await world.service.add(run(RUN.room), note());

  const error = await errorOf(
    world.service.edit(run(RUN.ui), {
      agentId: AGENT,
      noteId: shared.noteId,
      text: "Text from a private chat",
    })
  );

  expect(error).toMatchObject({ code: "invalid" });
  expect(await knows(world, person(USER_B))).toEqual([shared.noteId]);
  expect(
    (await world.service.list(person(USER_B), { agentId: AGENT }))[0]?.text
  ).toBe(note().text);
});
