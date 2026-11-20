import { expect, test } from "bun:test";
import { memoryChanges } from "@repo/db/schema/memory";
import { ForbiddenError } from "../authz.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  AGENT,
  connectorCall,
  errorOf,
  makeWorld,
  OWNER,
  person,
  RUN,
  run,
  SESSION,
  toolCall,
  USER_A,
  type World,
} from "./test-world.ts";

const note = {
  agentId: AGENT,
  kind: "people",
  text: "Mia wants Docs",
} as const;

const rows = (world: World) => world.db.select().from(memoryChanges).all();

const notesOf = async (world: World, userId = USER_A) =>
  await world.service.list(person(userId), { agentId: AGENT });

let eventCount = 0;
/** An event that reaches the log after the notes were written. */
const arrives = (
  world: World,
  runId: string,
  type: string,
  payload?: unknown
) => {
  eventCount += 1;
  world.seedEvent({ id: `ev_late_${eventCount}`, payload, runId, type });
};

// The runs service and the proxy call the hold as the system.
const holdAfter = (world: World, runId: string) =>
  world.service.holdAfterOutsideText(SYSTEM_PRINCIPAL, runId);

test("a note applied before a late web event arrives is held when the event lands", async () => {
  const world = makeWorld();
  const applied = await world.service.add(run(RUN.tools), note);
  expect(applied.status).toBe("applied");
  expect(await notesOf(world)).toHaveLength(1);

  arrives(world, RUN.tools, "tool.call", toolCall("WebFetch"));

  expect(await holdAfter(world, RUN.tools)).toBe(1);
  const [row] = rows(world);
  expect(row).toMatchObject({
    decidedAt: null,
    id: applied.id,
    libraryVersionId: null,
    status: "held",
  });
  expect(await notesOf(world)).toEqual([]);
});

test("a held note can be approved, and then it is in memory again", async () => {
  const world = makeWorld();
  const applied = await world.service.add(run(RUN.tools), note);
  arrives(world, RUN.tools, "tool.call", toolCall("Bash"));
  await holdAfter(world, RUN.tools);

  const decided = await world.service.decide(person(OWNER), {
    changeId: applied.id,
    decision: "approve",
  });

  expect(decided.status).toBe("applied");
  expect(await notesOf(world)).toMatchObject([{ id: applied.noteId }]);
  // Approved by a person, so a later event does not hold it again.
  expect(await holdAfter(world, RUN.tools)).toBe(0);
  expect(rows(world)[0]?.status).toBe("applied");
});

test("a note applied before a connector answered is held, and so is one before a shell call", async () => {
  const world = makeWorld();
  const first = await world.service.add(run(RUN.tools), note);
  arrives(
    world,
    RUN.tools,
    "connector.call",
    connectorCall("tools/call", "ok")
  );
  expect(await holdAfter(world, RUN.tools)).toBe(1);
  expect(rows(world).find((row) => row.id === first.id)?.status).toBe("held");

  const other = makeWorld();
  const shellNote = await other.service.add(run(RUN.ui), note);
  arrives(other, RUN.ui, "tool.call", toolCall("bash"));
  expect(await holdAfter(other, RUN.ui)).toBe(1);
  expect(rows(other).find((row) => row.id === shellNote.id)?.status).toBe(
    "held"
  );
});

test("a run with no outside text keeps its notes applied", async () => {
  const world = makeWorld();
  await world.service.add(run(RUN.tools), note);
  arrives(world, RUN.tools, "tool.call", toolCall("Read"));

  expect(await holdAfter(world, RUN.tools)).toBe(0);
  expect(rows(world)[0]?.status).toBe("applied");
  expect(await notesOf(world)).toHaveLength(1);
});

test("handshake and refused connector calls do not hold a note", async () => {
  const world = makeWorld();
  await world.service.add(run(RUN.tools), note);
  for (const [method, outcome] of [
    ["initialize", "ok"],
    ["tools/list", "ok"],
    ["tools/call", "denied"],
    ["tools/call", "timeout"],
  ] as const) {
    arrives(world, RUN.tools, "connector.call", connectorCall(method, outcome));
  }

  expect(await holdAfter(world, RUN.tools)).toBe(0);
  expect(rows(world)[0]?.status).toBe("applied");
});

test("an edit and the note it edited are both put back, newest first", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.tools), note);
  const edited = await world.service.edit(run(RUN.tools), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Mia wants Docs, always",
  });
  expect(edited.status).toBe("applied");
  arrives(world, RUN.tools, "tool.call", toolCall("web_fetch"));

  expect(await holdAfter(world, RUN.tools)).toBe(2);
  expect(rows(world).map((row) => row.status)).toEqual(["held", "held"]);
  expect(await notesOf(world)).toEqual([]);

  // The note comes back first, then its edit.
  await world.service.decide(person(OWNER), {
    changeId: added.id,
    decision: "approve",
  });
  await world.service.decide(person(OWNER), {
    changeId: edited.id,
    decision: "approve",
  });
  expect(await notesOf(world)).toMatchObject([
    { text: "Mia wants Docs, always" },
  ]);
});

test("a forget is undone and held, so the note stays until a person approves", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note);
  const forgotten = await world.service.forget(run(RUN.tools), {
    agentId: AGENT,
    noteId: added.noteId,
  });
  expect(await notesOf(world)).toEqual([]);
  arrives(world, RUN.tools, "tool.call", toolCall("WebSearch"));

  expect(await holdAfter(world, RUN.tools)).toBe(1);
  expect(await notesOf(world)).toMatchObject([{ id: added.noteId }]);
  expect(rows(world).find((row) => row.id === forgotten.id)?.status).toBe(
    "held"
  );
});

test("a note a subagent's sibling or parent wrote is held when any run of the family fetches", async () => {
  const world = makeWorld();
  world.seedRun({
    id: "r_late_parent",
    onBehalfOfUserId: USER_A,
    sessionId: SESSION.ui,
  });
  for (const id of ["r_late_a", "r_late_b"]) {
    world.seedRun({
      id,
      onBehalfOfUserId: USER_A,
      parentRunId: "r_late_parent",
      sessionId: SESSION.ui,
    });
  }
  const fromParent = await world.service.add(run("r_late_parent"), note);
  const fromSibling = await world.service.add(run("r_late_a"), {
    ...note,
    kind: "work",
  });
  arrives(world, "r_late_b", "tool.call", toolCall("web_fetch"));

  expect(await holdAfter(world, "r_late_b")).toBe(2);
  const status = (id: string) =>
    rows(world).find((row) => row.id === id)?.status;
  expect(status(fromParent.id)).toBe("held");
  expect(status(fromSibling.id)).toBe("held");
});

test("a private note goes back out of the person's own file", async () => {
  const world = makeWorld();
  const applied = await world.service.add(run(RUN.privateA), note);
  expect(applied).toMatchObject({ status: "applied", userScope: USER_A });
  arrives(world, RUN.privateA, "tool.call", toolCall("Bash"));

  expect(await holdAfter(world, RUN.privateA)).toBe(1);
  expect(await notesOf(world)).toEqual([]);
  expect(rows(world)[0]).toMatchObject({
    status: "held",
    userScope: USER_A,
  });
});

test("a note a person changed after the agent wrote it stays applied", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.tools), note);
  await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Mia wants Docs, from the owner",
  });
  arrives(world, RUN.tools, "tool.call", toolCall("WebFetch"));

  expect(await holdAfter(world, RUN.tools)).toBe(0);
  expect(rows(world).find((row) => row.id === added.id)?.status).toBe(
    "applied"
  );
  expect(await notesOf(world)).toMatchObject([
    { text: "Mia wants Docs, from the owner" },
  ]);
});

test("only the system may ask for the hold", async () => {
  const world = makeWorld();

  expect(
    await errorOf(world.service.holdAfterOutsideText(person(OWNER), RUN.tools))
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(world.service.holdAfterOutsideText(run(RUN.tools), RUN.tools))
  ).toBeInstanceOf(ForbiddenError);
});
