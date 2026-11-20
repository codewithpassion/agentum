import { expect, test } from "bun:test";
import { memoryChanges } from "@repo/db/schema/memory";
import { ForbiddenError } from "../authz.ts";
import {
  AGENT,
  errorOf,
  makeWorld,
  OWNER,
  person,
  RUN,
  run,
  SESSION,
  USER_A,
  USER_B,
  type World,
} from "./test-world.ts";

// The agent's owner is OWNER (its creator). USER_A and USER_B are plain members.
const ADMIN = person(USER_B, { isAdmin: true });

const note = (text = "Mia wants drafts as Google Docs") =>
  ({ agentId: AGENT, kind: "people", text }) as const;

const setLevel = async (
  world: World,
  learnLevel: "ask_first" | "tell_after"
) => {
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

const changeRows = (world: World) =>
  world.db.select().from(memoryChanges).all();

const statusOf = (world: World, changeId: string) =>
  changeRows(world).find((row) => row.id === changeId)?.status;

const sharedNotes = (world: World) =>
  world.service.list(person(USER_A), { agentId: AGENT });

test("only the owner or an admin can undo an applied shared change", async () => {
  const world = makeWorld();
  const refused = await world.service.add(run(RUN.ui), note());
  const undoneByOwner = await world.service.add(run(RUN.ui), note());
  const undoneByAdmin = await world.service.add(run(RUN.ui), note());

  expect(
    await errorOf(world.service.undo(person(USER_A), refused.id))
  ).toBeInstanceOf(ForbiddenError);
  expect((await sharedNotes(world)).map((item) => item.id)).toContain(
    refused.noteId
  );
  expect(statusOf(world, refused.id)).toBe("applied");

  await world.service.undo(person(OWNER), undoneByOwner.id);
  expect(statusOf(world, undoneByOwner.id)).toBe("undone");
  expect((await sharedNotes(world)).map((item) => item.id)).not.toContain(
    undoneByOwner.noteId
  );

  await world.service.undo(ADMIN, undoneByAdmin.id);
  expect(statusOf(world, undoneByAdmin.id)).toBe("undone");
  expect((await sharedNotes(world)).map((item) => item.id)).not.toContain(
    undoneByAdmin.noteId
  );
});

test("only the owner or an admin can edit a shared note", async () => {
  const world = makeWorld();
  const added = await world.service.add(run(RUN.ui), note());
  const rowsBefore = changeRows(world).length;

  expect(
    await errorOf(
      world.service.edit(person(USER_A), {
        agentId: AGENT,
        noteId: added.noteId,
        text: "Changed by a member",
      })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(await sharedNotes(world)).toEqual([
    expect.objectContaining({ id: added.noteId, text: note().text }),
  ]);
  expect(changeRows(world)).toHaveLength(rowsBefore);

  await world.service.edit(person(OWNER), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Changed by the owner",
  });
  expect(await sharedNotes(world)).toEqual([
    expect.objectContaining({ id: added.noteId, text: "Changed by the owner" }),
  ]);

  await world.service.edit(ADMIN, {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Changed by an admin",
  });
  expect(await sharedNotes(world)).toEqual([
    expect.objectContaining({ id: added.noteId, text: "Changed by an admin" }),
  ]);
});

test("only the owner or an admin can forget a shared note", async () => {
  const world = makeWorld();
  const kept = await world.service.add(run(RUN.ui), note());
  const forgottenByOwner = await world.service.add(run(RUN.ui), note());
  const forgottenByAdmin = await world.service.add(run(RUN.ui), note());
  const rowsBefore = changeRows(world).length;

  expect(
    await errorOf(
      world.service.forget(person(USER_A), {
        agentId: AGENT,
        noteId: kept.noteId,
      })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect((await sharedNotes(world)).map((item) => item.id)).toContain(
    kept.noteId
  );
  expect(changeRows(world)).toHaveLength(rowsBefore);

  await world.service.forget(person(OWNER), {
    agentId: AGENT,
    noteId: forgottenByOwner.noteId,
  });
  expect((await sharedNotes(world)).map((item) => item.id)).not.toContain(
    forgottenByOwner.noteId
  );

  await world.service.forget(ADMIN, {
    agentId: AGENT,
    noteId: forgottenByAdmin.noteId,
  });
  expect((await sharedNotes(world)).map((item) => item.id)).not.toContain(
    forgottenByAdmin.noteId
  );
});

test("only the owner or an admin can approve or reject a held shared change", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const approvedByOwner = await world.service.add(run(RUN.ui), note());
  const rejectedByAdmin = await world.service.add(run(RUN.ui), note());
  const refusedApprove = await world.service.add(run(RUN.ui), note());
  const refusedReject = await world.service.add(run(RUN.ui), note());

  expect(
    await errorOf(
      world.service.decide(person(USER_A), {
        changeId: refusedApprove.id,
        decision: "approve",
      })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(
      world.service.decide(person(USER_A), {
        changeId: refusedReject.id,
        decision: "reject",
      })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(statusOf(world, refusedApprove.id)).toBe("held");
  expect(statusOf(world, refusedReject.id)).toBe("held");
  expect(await sharedNotes(world)).toEqual([]);

  await world.service.decide(person(OWNER), {
    changeId: approvedByOwner.id,
    decision: "approve",
  });
  expect(statusOf(world, approvedByOwner.id)).toBe("applied");
  expect((await sharedNotes(world)).map((item) => item.id)).toContain(
    approvedByOwner.noteId
  );

  await world.service.decide(ADMIN, {
    changeId: rejectedByAdmin.id,
    decision: "reject",
  });
  expect(statusOf(world, rejectedByAdmin.id)).toBe("rejected");
  expect((await sharedNotes(world)).map((item) => item.id)).not.toContain(
    rejectedByAdmin.noteId
  );
});

test("a person still adds, edits, forgets and undoes their own private note", async () => {
  const world = makeWorld();
  const added = await world.service.add(person(USER_A), {
    ...note(),
    source: { id: SESSION.privateA, kind: "session" },
  });
  expect(added.userScope).toBe(USER_A);

  await world.service.edit(person(USER_A), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Mia wants Docs",
  });
  const mine = () => world.service.list(person(USER_A), { agentId: AGENT });
  expect(await mine()).toEqual([
    expect.objectContaining({ id: added.noteId, text: "Mia wants Docs" }),
  ]);

  const forgotten = await world.service.forget(person(USER_A), {
    agentId: AGENT,
    noteId: added.noteId,
  });
  expect(await mine()).toEqual([]);

  await world.service.undo(person(USER_A), forgotten.id);
  expect(await mine()).toEqual([
    expect.objectContaining({ id: added.noteId, text: "Mia wants Docs" }),
  ]);
});

test("a person decides a held private change of their own", async () => {
  const world = makeWorld();
  await setLevel(world, "ask_first");
  const held = await world.service.add(run(RUN.privateA), note());

  const decided = await world.service.decide(person(USER_A), {
    changeId: held.id,
    decision: "approve",
  });

  expect(decided).toMatchObject({ decidedBy: USER_A, status: "applied" });
  expect(
    (await world.service.list(person(USER_A), { agentId: AGENT })).map(
      (item) => item.id
    )
  ).toEqual([held.noteId]);
});

test("a run still edits a shared note at tell_after", async () => {
  const world = makeWorld();
  await setLevel(world, "tell_after");
  const added = await world.service.add(run(RUN.ui), note());

  const edit = await world.service.edit(run(RUN.ui), {
    agentId: AGENT,
    noteId: added.noteId,
    text: "Changed by the agent",
  });

  expect(edit).toMatchObject({ status: "applied" });
  expect(await sharedNotes(world)).toEqual([
    expect.objectContaining({ id: added.noteId, text: "Changed by the agent" }),
  ]);
});
