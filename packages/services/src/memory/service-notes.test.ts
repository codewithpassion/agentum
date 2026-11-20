import { expect, test } from "bun:test";
import { libraryEntries } from "@repo/db/schema/library";
import { memoryChanges } from "@repo/db/schema/memory";
import { workspaces } from "@repo/db/schema/workspaces";
import type { LearnLevel } from "@repo/db/shared";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { parseMemoryFile } from "./codec.ts";
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
  WORKSPACE,
  type World,
} from "./test-world.ts";

const note = (kind: "people" | "corrections" | "work" | "places" = "people") =>
  ({ agentId: AGENT, kind, text: "Mia wants drafts as Google Docs" }) as const;

const setLevel = async (
  world: World,
  learnLevel: LearnLevel,
  never: string[] = []
) => {
  await world.service.rules.set(person(OWNER), {
    agentId: AGENT,
    rules: {
      dreamSchedule: "nightly",
      learnLevel,
      never,
      remember: [],
      shareWithTeam: true,
    },
  });
};

const readFile = async (
  world: World,
  principal = person(USER_A),
  name = "people.md"
) => text((await world.library.read(principal, `${MEMORY}/${name}`)).bytes);

/** What reading a memory file fails with, as person A. */
const readError = (world: World, name: string) =>
  errorOf(world.library.read(person(USER_A), `${MEMORY}/${name}`));

const NOT_FOUND = { code: "not_found" };

const changeRows = (world: World) =>
  world.db.select().from(memoryChanges).all();

// Levels.

test("tell_after applies an agent's note at once, with a version, an index and a change row", async () => {
  const world = makeWorld();

  const change = await world.service.add(run(RUN.ui), note());

  expect(change).toMatchObject({
    action: "add",
    kind: "people",
    source: { id: RUN.ui, kind: "run" },
    status: "applied",
    userScope: null,
    writtenBy: "agent",
  });
  expect(change.libraryVersionId).toBeString();
  const file = await readFile(world);
  expect(file).toContain(`- id: ${change.noteId}`);
  expect(file).toContain("  by: agent");
  expect(file).toContain("  source: run:r_ui");
  expect(await readFile(world, person(USER_A), "index.md")).toContain(
    `- ${change.noteId}: Mia wants drafts as Google Docs`
  );
  const versions = await world.library.versions(
    person(USER_A),
    `${MEMORY}/people.md`
  );
  expect(versions.map((version) => version.id)).toContain(
    String(change.libraryVersionId)
  );
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual([
    expect.objectContaining({ id: change.noteId, writtenBy: "agent" }),
  ]);
});

test("quiet applies an agent's note at once too", async () => {
  const world = makeWorld();
  await setLevel(world, "quiet");

  const change = await world.service.add(run(RUN.ui), note());

  expect(change.status).toBe("applied");
  expect(await readFile(world)).toContain(change.noteId);
});

test("ask_first holds an agent's note: a held row, no file, no version", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");

  const change = await world.service.add(run(RUN.ui), note());

  expect(change).toMatchObject({ libraryVersionId: null, status: "held" });
  expect(await readError(world, "people.md")).toMatchObject(NOT_FOUND);
  expect(await readError(world, "index.md")).toMatchObject(NOT_FOUND);
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
  expect(changeRows(world)).toHaveLength(1);
  expect(world.db.select().from(libraryEntries).all()).toEqual([]);
});

test("ask_first still applies a person's own add, edit and forget", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");

  const added = await world.service.add(person(USER_A), note());
  expect(added).toMatchObject({ status: "applied", writtenBy: "person" });
  const edited = await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Mia wants Google Docs",
  });
  expect(edited).toMatchObject({ action: "edit", status: "applied" });
  const [current] = await world.service.list(person(USER_A), {
    agentId: AGENT,
  });
  expect(current).toMatchObject({
    text: "Mia wants Google Docs",
    writtenBy: "person",
  });
  const forgotten = await world.service.forget(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
  });
  expect(forgotten).toMatchObject({
    action: "forget",
    status: "applied",
    text: "Mia wants Google Docs",
  });
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
});

test("ask_first holds an agent's edit and forget of a note too", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());
  await setLevel(world, "ask_first");

  const edit = await world.service.edit(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Changed",
  });
  const forget = await world.service.forget(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
  });

  expect([edit.status, forget.status]).toEqual(["held", "held"]);
  expect(await readFile(world)).toContain("Mia wants drafts as Google Docs");
});

test("an edit keeps the note's id and source and sets the day and writer", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());

  await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "  Mia wants\nGoogle Docs  ",
  });

  const [edited] = await world.service.list(person(USER_A), {
    agentId: AGENT,
  });
  expect(edited).toEqual({
    date: "2026-11-20",
    id: added.noteId,
    kind: "people",
    source: { id: RUN.ui, kind: "run" },
    text: "Mia wants Google Docs",
    userScope: null,
    writtenBy: "person",
  });
});

test("list filters by kind, and an unknown note is not found", async () => {
  const world = makeWorld();
  await world.service.add(person(USER_A), note("people"));
  await world.service.add(person(USER_A), note("work"));

  expect(
    (await world.service.list(person(USER_A), { agentId: AGENT })).map(
      (item) => item.kind
    )
  ).toEqual(["people", "work"]);
  expect(
    await world.service.list(person(USER_A), { agentId: AGENT, kind: "work" })
  ).toHaveLength(1);
  expect(
    await errorOf(
      world.service.forget(person(OWNER), { agentId: AGENT, noteId: "nope" })
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(
      world.service.edit(person(OWNER), {
        agentId: AGENT,
        noteId: "nope",
        text: "x",
      })
    )
  ).toMatchObject({ code: "not_found" });
});

// Guard rules.

const KEY_NOTE = "The key is AKIAIOSFODNN7EXAMPLE for staging";
const CARD_NOTE = "Card 4242 4242 4242 4242 expires next year";
const secrets = [
  KEY_NOTE,
  CARD_NOTE,
  "password is hunter2hunter2",
  "Use Bearer abcdefghijklmnopqrstuvwxyz0123456789 for the API",
];

test("a note that matches a secret pattern is refused, whoever writes it, and leaves no trace", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());

  const errors = await Promise.all(
    secrets.flatMap((secret) =>
      [person(USER_A), run(RUN.ui)].map((principal) =>
        errorOf(world.service.add(principal, { ...note(), text: secret }))
      )
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({ code: "invalid" });
    expect(String(error)).not.toContain("hunter2");
  }
  expect(
    await errorOf(
      world.service.edit(person(OWNER), {
        agentId: AGENT,
        noteId: added.noteId,
        text: KEY_NOTE,
      })
    )
  ).toMatchObject({ code: "invalid" });
  expect(changeRows(world)).toHaveLength(1);
});

test("a held level does not turn a secret into a held note: it is refused first", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");

  expect(
    await errorOf(
      world.service.add(run(RUN.ui), { ...note(), text: CARD_NOTE })
    )
  ).toMatchObject({ code: "invalid" });
  expect(changeRows(world)).toEqual([]);
});

test("a note from mail, a web page or an A2A peer is held at every level", async () => {
  const world = makeWorld();
  const statuses: string[] = [];
  for (const level of ["quiet", "tell_after"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each level is set before its notes are written
    await setLevel(world, level);
    const fromMail = await world.service.add(run(RUN.mail), note());
    const fromWeb = await world.service.add(run(RUN.web), note());
    statuses.push(fromMail.status, fromWeb.status);
  }
  expect(statuses).toEqual(["held", "held", "held", "held"]);
  expect(await readError(world, "people.md")).toMatchObject(NOT_FOUND);
});

test("a note a person writes from a mail conversation still applies", async () => {
  const world = makeWorld();

  const change = await world.service.add(person(USER_A), {
    ...note(),
    source: { id: SESSION.mail, kind: "session" },
  });

  expect(change.status).toBe("applied");
});

test("a peer-origin run cannot remember or forget, and nothing is recorded", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());

  const errors = await Promise.all(
    [RUN.peer, "r_peer_child"].flatMap((peerRun) => [
      errorOf(world.service.add(run(peerRun), note())),
      errorOf(
        world.service.forget(run(peerRun), {
          agentId: AGENT,
          noteId: added.noteId,
        })
      ),
      errorOf(
        world.service.edit(run(peerRun), {
          agentId: AGENT,
          noteId: added.noteId,
          text: "x",
        })
      ),
    ])
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ForbiddenError);
  }
  expect(changeRows(world)).toHaveLength(1);
});

test("a run writes as itself and cannot name another source", async () => {
  const world = makeWorld();

  expect(
    await errorOf(
      world.service.add(run(RUN.ui), {
        ...note(),
        source: { id: SESSION.ui, kind: "session" },
      })
    )
  ).toMatchObject({ code: "invalid" });
  expect(
    await errorOf(
      world.service.add(person(USER_A), {
        ...note(),
        source: { id: "missing", kind: "session" },
      })
    )
  ).toMatchObject({ code: "invalid" });
});

// Never list.

const SALARY_NOTE = "Tom asked about his salary review";

test("a note that mentions an entry of the agent's never list is refused and recorded", async () => {
  const world = makeWorld();
  await setLevel(world, "tell_after", ["Salary"]);

  const error = await errorOf(
    world.service.add(run(RUN.ui), { ...note(), text: SALARY_NOTE })
  );

  expect(error).toMatchObject({ code: "invalid" });
  expect(String(error)).toContain('"Salary"');
  expect(String(error)).toContain("never-remember list");
  expect(String(error)).toContain("this agent's");
  const rows = changeRows(world);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "add",
    decidedBy: null,
    kind: "people",
    libraryVersionId: null,
    status: "rejected",
    writtenBy: "agent",
  });
  expect(rows[0]?.decidedAt).not.toBeNull();
  expect(rows[0]?.text).toContain("Salary");
  expect(rows[0]?.text).not.toContain("review");
  expect(await readError(world, "people.md")).toMatchObject(NOT_FOUND);
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
});

test("the workspace never list refuses too", async () => {
  const world = makeWorld();
  world.db
    .update(workspaces)
    .set({ neverRemember: JSON.stringify(["Health details"]) })
    .where(eq(workspaces.id, WORKSPACE))
    .run();

  const error = await errorOf(
    world.service.add(run(RUN.ui), {
      ...note(),
      text: "Mia shared her health details",
    })
  );

  expect(error).toMatchObject({ code: "invalid" });
  expect(String(error)).toContain("the workspace's");
  expect(changeRows(world).map((row) => row.status)).toEqual(["rejected"]);
  const clean = await world.service.add(run(RUN.ui), note());
  expect(clean.status).toBe("applied");
});

test("a person's add and edit are refused too, and an edit keeps the note as it was", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());
  await setLevel(world, "tell_after", ["Salary"]);

  const edit = await errorOf(
    world.service.edit(person(OWNER), {
      agentId: AGENT,
      noteId: added.noteId,
      text: "Tom's salary",
    })
  );
  const create = await errorOf(
    world.service.add(person(USER_A), { ...note(), text: "Tom's salary" })
  );

  expect(edit).toMatchObject({ code: "invalid" });
  expect(create).toMatchObject({ code: "invalid" });
  expect(await readFile(world)).toContain("Mia wants drafts as Google Docs");
  expect(
    changeRows(world).filter((row) => row.status === "rejected")
  ).toMatchObject([
    { action: "edit", noteId: added.noteId },
    { action: "add", writtenBy: "person" },
  ]);
});

test("a forget of a note that mentions a never list entry still works", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), {
    ...note(),
    text: SALARY_NOTE,
  });
  await setLevel(world, "tell_after", ["Salary"]);

  const forgotten = await world.service.forget(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
  });

  expect(forgotten).toMatchObject({ action: "forget", status: "applied" });
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
});

test("ask_first does not hold a note the never list refuses", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first", ["Salary"]);

  expect(
    await errorOf(
      world.service.add(run(RUN.ui), { ...note(), text: SALARY_NOTE })
    )
  ).toMatchObject({ code: "invalid" });
  expect(changeRows(world).map((row) => row.status)).toEqual(["rejected"]);
});

test("a private note refused by the never list stays private", async () => {
  const world = makeWorld();
  await setLevel(world, "tell_after", ["Salary"]);

  expect(
    await errorOf(
      world.service.add(run(RUN.privateA), { ...note(), text: SALARY_NOTE })
    )
  ).toMatchObject({ code: "invalid" });
  const rows = changeRows(world);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "rejected", userScope: USER_A });
  expect(
    await world.service.changes(person(USER_B), { agentId: AGENT })
  ).toEqual([]);
  expect(
    (await world.service.changes(person(USER_A), { agentId: AGENT })).map(
      (change) => change.id
    )
  ).toEqual(rows.map((row) => row.id));
});

test("a note that only shares part of a never list entry is kept", async () => {
  const world = makeWorld();
  await setLevel(world, "tell_after", ["Health details"]);

  const change = await world.service.add(run(RUN.ui), {
    ...note(),
    text: "Mia keeps health records in the Sales sheet",
  });

  expect(change.status).toBe("applied");
});

// Private scope.

test("a note from a private session goes to the person's private file", async () => {
  const world = makeWorld();

  const change = await world.service.add(run(RUN.privateA), note("work"));

  expect(change.userScope).toBe(USER_A);
  const file = await readFile(world, person(USER_A), "private/user_a.md");
  expect(file).toContain(`- id: ${change.noteId}`);
  expect(file).toContain("  kind: work");
  expect(await readError(world, "work.md")).toMatchObject(NOT_FOUND);
  expect(await readFile(world, person(USER_A), "index.md")).not.toContain(
    change.noteId
  );
});

test("private notes are visible to that person and the agent's runs for that person only", async () => {
  const world = makeWorld();
  const mine = await world.service.add(run(RUN.privateA), note());
  const theirs = await world.service.add(run(RUN.privateB), note());
  const shared = await world.service.add(person(USER_A), note("places"));

  const ids = async (principal: ReturnType<typeof person>) =>
    (await world.service.list(principal, { agentId: AGENT }))
      .map((item) => item.id)
      .sort();

  // Person A, a run for A, person B, a run for B, and a run for nobody.
  expect(await ids(person(USER_A))).toEqual(
    [mine.noteId, shared.noteId].sort()
  );
  expect(await ids(run(RUN.ui))).toEqual([mine.noteId, shared.noteId].sort());
  expect(await ids(person(USER_B))).toEqual(
    [theirs.noteId, shared.noteId].sort()
  );
  expect(await ids(run(RUN.privateB))).toEqual(
    [theirs.noteId, shared.noteId].sort()
  );
  expect(await ids(run(RUN.mail))).toEqual([shared.noteId]);
  // The library hides the file from everyone else.
  expect(
    await errorOf(
      world.library.read(person(USER_B), `${MEMORY}/private/user_a.md`)
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(
      world.library.read(run(RUN.privateB), `${MEMORY}/private/user_a.md`)
    )
  ).toMatchObject({ code: "not_found" });
  expect(await readFile(world, run(RUN.ui), "private/user_a.md")).toContain(
    mine.noteId
  );
});

test("another person cannot see, edit, forget or decide a private change", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.privateA), note());
  await setLevel(world, "tell_after");
  const applied = await world.service.add(run(RUN.privateA), note());

  expect(
    (await world.service.changes(person(USER_B), { agentId: AGENT })).length
  ).toBe(0);
  expect(
    (await world.service.changes(person(USER_A), { agentId: AGENT })).length
  ).toBe(2);
  expect(
    await errorOf(
      world.service.decide(person(USER_B), {
        changeId: held.id,
        decision: "approve",
      })
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(world.service.undo(person(USER_B), applied.id))
  ).toMatchObject({
    code: "not_found",
  });
  expect(
    await errorOf(
      world.service.forget(person(USER_B), {
        agentId: AGENT,
        noteId: applied.noteId,
      })
    )
  ).toMatchObject({ code: "not_found" });
});

test("a private conversation of someone else cannot be a person's source", async () => {
  const world = makeWorld();

  expect(
    await errorOf(
      world.service.add(person(USER_A), {
        ...note(),
        source: { id: SESSION.privateB, kind: "session" },
      })
    )
  ).toMatchObject({ code: "not_found" });
  const own = await world.service.add(person(USER_A), {
    ...note(),
    source: { id: SESSION.privateA, kind: "session" },
  });
  expect(own.userScope).toBe(USER_A);
});

// Decide.

test("approving a held note writes it and clears the item", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());

  const decided = await world.service.decide(person(OWNER), {
    changeId: held.id,
    decision: "approve",
  });

  expect(decided).toMatchObject({
    decidedBy: OWNER,
    id: held.id,
    status: "applied",
  });
  expect(decided.libraryVersionId).toBeString();
  expect(decided.decidedAt).toBeString();
  expect(await readFile(world)).toContain(`- id: ${held.noteId}`);
  expect(
    await world.service.changes(person(USER_A), {
      agentId: AGENT,
      status: "held",
    })
  ).toEqual([]);
  expect(
    await errorOf(
      world.service.decide(person(OWNER), {
        changeId: held.id,
        decision: "approve",
      })
    )
  ).toMatchObject({ code: "conflict" });
});

test("approving a held edit and a held forget changes the note", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());
  await setLevel(world, "ask_first");
  const edit = await world.service.edit(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Mia wants Docs",
  });
  const forget = await world.service.forget(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
  });

  await world.service.decide(person(OWNER), {
    changeId: edit.id,
    decision: "approve",
  });
  expect(await readFile(world)).toContain("Mia wants Docs");
  await world.service.decide(person(OWNER), {
    changeId: forget.id,
    decision: "approve",
  });
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
});

test("rejecting a held note leaves memory alone and records who decided", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());

  const decided = await world.service.decide(person(OWNER), {
    changeId: held.id,
    decision: "reject",
  });

  expect(decided).toMatchObject({
    decidedBy: OWNER,
    libraryVersionId: null,
    status: "rejected",
  });
  expect(await readError(world, "people.md")).toMatchObject(NOT_FOUND);
});

test("a run, a key and a missing change cannot decide", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());
  const input = { changeId: held.id, decision: "approve" } as const;

  expect(
    await errorOf(world.service.decide(run(RUN.ui), input))
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(
      world.service.decide(
        person(USER_B, { apiKey: { access: "read", id: "k" }, via: "api_key" }),
        input
      )
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(
      world.service.decide(person(OWNER), { ...input, changeId: "nope" })
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    (await world.service.changes(person(USER_A), { agentId: AGENT }))[0]?.status
  ).toBe("held");
});

// Undo.

test("undo of an add removes the note and marks the change undone", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());

  const undone = await world.service.undo(person(OWNER), added.id);

  expect(undone).toMatchObject({ decidedBy: OWNER, status: "undone" });
  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
  expect(await readFile(world, person(USER_A), "index.md")).not.toContain(
    added.noteId
  );
  expect(
    await errorOf(world.service.undo(person(OWNER), added.id))
  ).toMatchObject({ code: "conflict" });
});

test("undo of an edit restores the text, date and writer from the earlier version", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());
  const before = await world.service.list(person(USER_A), {
    agentId: AGENT,
  });
  const edit = await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Changed",
  });

  await world.service.undo(person(OWNER), edit.id);

  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    before
  );
});

test("undo of a forget brings the note back as it was", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());
  const before = await world.service.list(person(USER_A), {
    agentId: AGENT,
  });
  const forget = await world.service.forget(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
  });

  await world.service.undo(person(OWNER), forget.id);

  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    before
  );
});

test("undo refuses when the note changed since, and a held or rejected change", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());
  await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Newer text",
  });
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());

  expect(
    await errorOf(world.service.undo(person(OWNER), added.id))
  ).toMatchObject({ code: "conflict" });
  expect(
    await errorOf(world.service.undo(person(OWNER), held.id))
  ).toMatchObject({
    code: "conflict",
  });
  expect(
    await errorOf(world.service.undo(run(RUN.ui), added.id))
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(world.service.undo(person(OWNER), "nope"))
  ).toMatchObject({
    code: "not_found",
  });
  expect(await readFile(world)).toContain("Newer text");
});

test("undo works on a private note", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.privateA), note());

  await world.service.undo(person(USER_A), added.id);

  expect(await world.service.list(person(USER_A), { agentId: AGENT })).toEqual(
    []
  );
});

// Writes through the library only.

test("no run can write the memory folder through the library", async () => {
  const world = makeWorld();
  await world.service.add(person(USER_A), note());

  expect(
    await errorOf(
      world.library.write(
        run(RUN.ui),
        `${MEMORY}/people.md`,
        new TextEncoder().encode("# People\n")
      )
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(world.library.remove(run(RUN.ui), `${MEMORY}/people.md`))
  ).toBeInstanceOf(ForbiddenError);
  expect(await readFile(world)).toContain("Mia wants");
});

test("a person may fix a file by hand, and a file that does not parse is reported and left alone", async () => {
  const world = makeWorld();
  await world.service.add(person(USER_A), note("work"));
  const broken = "# People\n\n- id: not-a-ulid\n";
  await world.library.write(
    person(USER_A),
    `${MEMORY}/people.md`,
    new TextEncoder().encode(broken)
  );

  const error = await errorOf(
    world.service.add(person(USER_A), note("people"))
  );
  expect(error).toMatchObject({ code: "invalid" });
  expect(String(error)).toContain("people.md");
  expect(String(error)).toContain("line 3");
  expect(await readFile(world)).toBe(broken);
  // The other kinds still work, and the broken file's notes are skipped.
  await world.service.add(person(USER_A), note("places"));
  expect(
    (await world.service.list(person(USER_A), { agentId: AGENT })).map(
      (item) => item.kind
    )
  ).toEqual(["work", "places"]);
});

test("approving a held add or undoing a forget never overwrites a file that does not parse", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), note());
  const forgotten = await world.service.forget(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
  });
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.ui), note());
  const broken = "# People\n\n- id: not-a-ulid\n";
  await world.library.write(
    person(USER_A),
    `${MEMORY}/people.md`,
    new TextEncoder().encode(broken)
  );

  const approve = await errorOf(
    world.service.decide(person(OWNER), {
      changeId: held.id,
      decision: "approve",
    })
  );
  const undo = await errorOf(world.service.undo(person(OWNER), forgotten.id));

  expect(approve).toMatchObject({ code: "invalid" });
  expect(String(approve)).toContain("people.md");
  expect(undo).toMatchObject({ code: "invalid" });
  expect(await readFile(world)).toBe(broken);
  const rows = changeRows(world);
  expect(rows.find((row) => row.id === held.id)?.status).toBe("held");
  expect(rows.find((row) => row.id === forgotten.id)?.status).toBe("applied");
});

// Atomic.

test("a failed library write leaves no change row, no entry and no version", async () => {
  const world = makeWorld({
    blobs: (inner) => ({
      ...inner,
      put: () => Promise.reject(new Error("R2 is down")),
    }),
  });

  expect(
    await errorOf(world.service.add(person(USER_A), note()))
  ).toBeInstanceOf(Error);

  expect(changeRows(world)).toEqual([]);
  expect(world.db.select().from(libraryEntries).all()).toEqual([]);
});

test("a failed atomic call leaves no change row and no library rows", async () => {
  const world = makeWorld({
    atomic: () => Promise.reject(new Error("D1 is down")),
  });

  expect(
    await errorOf(world.service.add(person(USER_A), note()))
  ).toBeInstanceOf(Error);

  expect(changeRows(world)).toEqual([]);
  expect(world.db.select().from(libraryEntries).all()).toEqual([]);
});

test("an add and its change row land together, and a failed first try is retried on a stale etag", async () => {
  let stale = true;
  const world = makeWorld({
    blobs: (inner) => ({
      ...inner,
      put: (key, bytes, options) => {
        if (stale && options?.ifEtag !== undefined) {
          stale = false;
          return Promise.resolve(null);
        }
        return inner.put(key, bytes, options);
      },
    }),
  });
  const first = await world.service.add(person(USER_A), note());

  const second = await world.service.add(person(USER_A), note());

  expect(stale).toBe(false);
  expect(
    world.db
      .select()
      .from(memoryChanges)
      .where(eq(memoryChanges.status, "applied"))
      .all()
      .map((row) => row.noteId)
      .sort()
  ).toEqual([first.noteId, second.noteId].sort());
  const parsed = parseMemoryFile("people.md", await readFile(world));
  expect(parsed.ok && parsed.notes).toHaveLength(2);
});
