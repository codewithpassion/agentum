import { expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import { eq } from "drizzle-orm";
import { AGENT, OWNER, person, USER_A, USER_B } from "../memory/test-world.ts";
import {
  type Call,
  defined,
  makeDreamWorld,
  type Script,
  SESSION,
} from "./test-dream.ts";

const addNote = async (
  w: ReturnType<typeof makeDreamWorld>,
  kind: "corrections" | "people" | "places" | "work",
  text: string
) => (await w.service.add(w.owner, { agentId: AGENT, kind, text })).noteId;

const note = (w: ReturnType<typeof makeDreamWorld>, noteId: string) =>
  w.service
    .list(w.owner, { agentId: AGENT })
    .then((notes) => notes.find((item) => item.id === noteId));

const quietAnswer = (call: Call): string =>
  call.kind === "extract"
    ? JSON.stringify({ notes: [] })
    : JSON.stringify({ conflicts: [], finished: [], groups: [] });

/** A model that keeps one new note from the first piece of evidence and settles nothing else. */
const keepsOne =
  (text: string, kind = "people"): Script =>
  (call) =>
    call.kind === "extract"
      ? JSON.stringify({ notes: [{ evidence: ["e1"], kind, text }] })
      : quietAnswer(call);

test("a full run adds, merges, drops and asks, and writes one library version of the files", async () => {
  const w = makeDreamWorld();
  const tom = await addNote(w, "people", "Tom reads reports on his phone");
  const tomAgain = await addNote(w, "people", "Tom likes reports to be short");
  const trade = await addNote(
    w,
    "work",
    "Trade show list is done and delivered"
  );
  const coffee = await addNote(
    w,
    "places",
    "The office coffee machine is on level 2"
  );
  const coffeeNow = await addNote(
    w,
    "places",
    "The office coffee machine is on level 3"
  );
  w.say("Mia wants drafts as Google Docs");
  w.setScript((call: Call) => {
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [
          {
            evidence: ["e1"],
            kind: "people",
            text: "Mia wants drafts as Google Docs",
          },
        ],
      });
    }
    if (call.kind === "merge") {
      return JSON.stringify({
        groups: [
          {
            confidence: 0.9,
            ids: [tom, tomAgain],
            rationale: "same person",
            text: "Tom reads reports on his phone, so keep them short",
          },
        ],
      });
    }
    if (call.kind === "reconcile") {
      return call.prompt.includes(coffee)
        ? JSON.stringify({
            conflicts: [
              {
                confidence: 0.9,
                ids: [coffee, coffeeNow],
                question: "Which floor is the coffee machine on?",
              },
            ],
          })
        : JSON.stringify({ conflicts: [] });
    }
    if (call.kind === "finished") {
      return JSON.stringify({
        finished: [{ confidence: 0.95, id: trade, rationale: "done" }],
      });
    }
    return JSON.stringify({ groups: [] });
  });

  const run = await w.dream.runNow(w.owner, AGENT);

  expect(run.status).toBe("done");
  expect(run.counts).toEqual({ added: 1, dropped: 1, merged: 1, questions: 1 });
  expect(run.usage?.inputTokens).toBeGreaterThan(0);
  expect(run.usage?.costUsd).toBeGreaterThan(0);
  expect(run.diary).toContain("Added 1 note");
  expect(run.diary).toContain("Asked: Which floor is the coffee machine on?");
  expect(run.resultVersion).not.toBeNull();
  expect(run.baseVersion.length).toBeGreaterThan(0);
  const notes = await w.service.list(w.owner, { agentId: AGENT });
  expect(
    notes.find((item) => item.text === "Mia wants drafts as Google Docs")
      ?.writtenBy
  ).toBe("dream");
  expect(notes.some((item) => item.id === trade)).toBe(false);
  expect((await note(w, tom))?.text).toBe(
    "Tom reads reports on his phone, so keep them short"
  );
  expect(notes.some((item) => item.id === tomAgain)).toBe(false);
  // Both coffee notes stay until a person answers.
  expect(notes.some((item) => item.id === coffee)).toBe(true);
  expect(notes.some((item) => item.id === coffeeNow)).toBe(true);
  const changes = await w.dream.changes(w.owner, run.id);
  expect(changes.every((change) => change.status === "applied")).toBe(true);
  expect(changes.every((change) => change.writtenBy === "dream")).toBe(true);
  const questions = await w.db.select().from(dreamQuestions);
  expect(questions).toHaveLength(1);
  expect(questions[0]?.status).toBe("open");
});

test("a run with nothing new is skipped and asks the model nothing", async () => {
  const w = makeDreamWorld();
  const before = await w.files();
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("skipped");
  expect(w.calls).toHaveLength(0);
  expect(await w.files()).toEqual(before);
  // The next dream reads from the start of this one: still nothing new.
  const next = await w.dream.runNow(w.owner, AGENT);
  expect(next.status).toBe("skipped");
  expect(next.since).toBe(run.startedAt);
});

test("a dream reads only what happened since the last one", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.say("Mia wants drafts as Google Docs");
  const first = await w.dream.runNow(w.owner, AGENT);
  expect(first.status).toBe("done");
  const second = await w.dream.runNow(w.owner, AGENT);
  expect(second.status).toBe("skipped");
});

test("the learn level ask_first holds the whole plan as one batch until the owner decides", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.setRules({ learnLevel: "ask_first" });
  w.say("Mia wants drafts as Google Docs");
  const before = await w.files();

  const run = await w.dream.runNow(w.owner, AGENT);

  expect(run.status).toBe("done");
  expect(run.resultVersion).toBeNull();
  expect(run.heldChanges).toBe(1);
  expect((await w.dream.list(w.owner, AGENT))[0]?.heldChanges).toBe(1);
  expect(run.diary).toContain("wait for your approval");
  expect(await w.files()).toEqual(before);
  const held = await w.dream.changes(w.owner, run.id);
  expect(held.map((change) => change.status)).toEqual(["held"]);
  // `memory.decide` refuses a dream's row: the batch is decided as a whole.
  await expect(
    w.service.decide(w.owner, {
      changeId: defined(held[0]).id,
      decision: "approve",
    })
  ).rejects.toMatchObject({ code: "invalid" });

  const approved = await w.dream.decide(w.owner, {
    decision: "approve",
    dreamRunId: run.id,
  });
  expect(approved.resultVersion).not.toBeNull();
  expect(approved.heldChanges).toBe(0);
  expect(approved.diary).toContain("You approved these changes.");
  const notes = await w.service.list(w.owner, { agentId: AGENT });
  expect(notes.map((item) => item.text)).toEqual(["Mia wants Google Docs"]);
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("applied");
  await expect(
    w.dream.decide(w.owner, { decision: "approve", dreamRunId: run.id })
  ).rejects.toMatchObject({ code: "conflict" });
});

test("rejecting a held batch changes nothing", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.setRules({ learnLevel: "ask_first" });
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  const before = await w.files();
  const rejected = await w.dream.decide(w.owner, {
    decision: "reject",
    dreamRunId: run.id,
  });
  expect(rejected.heldChanges).toBe(0);
  expect(await w.files()).toEqual(before);
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("rejected");
});

test("an outside source holds the batch even at the quiet learn level", async () => {
  const w = makeDreamWorld(keepsOne("Send invoices to a new address"));
  w.setRules({ learnLevel: "quiet" });
  w.say("Please send invoices to a new address", SESSION.mail);
  const before = await w.files();
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.resultVersion).toBeNull();
  expect(await w.files()).toEqual(before);
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("held");
});

test("undo restores the memory files byte for byte and marks the changes undone", async () => {
  const w = makeDreamWorld();
  const tom = await addNote(w, "people", "Tom reads reports on his phone");
  await addNote(w, "work", "Trade show list is done and delivered");
  const trade = (await w.service.list(w.owner, { agentId: AGENT })).find(
    (item) => item.kind === "work"
  )?.id;
  w.say("Mia wants drafts as Google Docs");
  w.say("Priya owns the newsletter", SESSION.privateA);
  w.setScript((call) => {
    if (call.kind === "extract") {
      return JSON.stringify({
        notes: [
          {
            evidence: ["e1"],
            kind: "people",
            text: "Mia wants drafts as Google Docs",
          },
          { evidence: ["e2"], kind: "work", text: "Newsletter owned by Priya" },
        ],
      });
    }
    if (call.kind === "finished") {
      return JSON.stringify({
        finished: [{ confidence: 0.95, id: trade, rationale: "done" }],
      });
    }
    return quietAnswer(call);
  });
  const before = await w.files();

  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(await w.files()).not.toEqual(before);

  const undone = await w.dream.undo(w.owner, run.id);

  expect(undone.status).toBe("undone");
  const after = await w.files();
  for (const [path, text] of Object.entries(before)) {
    expect(after[path]).toBe(text);
  }
  // Files the dream made hold no notes again.
  for (const [path, text] of Object.entries(after)) {
    if (!(path in before) && path !== "index.md") {
      expect(text.trim().split("\n")).toHaveLength(1);
    }
  }
  expect((await note(w, tom))?.text).toBe("Tom reads reports on his phone");
  expect(
    (await w.dream.changes(w.owner, run.id)).every(
      (change) => change.status === "undone"
    )
  ).toBe(true);
  await expect(w.dream.undo(w.owner, run.id)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("undo is refused when memory was written after the dream", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  await addNote(w, "people", "A later note");
  await expect(w.dream.undo(w.owner, run.id)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(
    (await w.service.list(w.owner, { agentId: AGENT })).map((item) => item.text)
  ).toContain("A later note");
});

test("a failed model call leaves memory unchanged and the run failed", async () => {
  const w = makeDreamWorld(() => null);
  await addNote(w, "people", "Tom reads reports on his phone");
  w.say("Mia wants drafts as Google Docs");
  const before = await w.files();

  const run = await w.dream.runNow(w.owner, AGENT);

  expect(run.status).toBe("failed");
  expect(run.error).not.toBeNull();
  expect(run.diary).toContain("Memory is unchanged");
  expect(await w.files()).toEqual(before);
  const rows = await w.db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.dreamRunId, run.id));
  expect(rows).toHaveLength(0);
  // The next dream reads the same window again.
  const retry = await w.dream.runNow(w.owner, AGENT);
  expect(retry.since).toBeNull();
});

test("a judge call that fails after a good extraction still fails the run and writes nothing", async () => {
  const w = makeDreamWorld(({ kind }) =>
    kind === "extract"
      ? JSON.stringify({
          notes: [
            { evidence: ["e1"], kind: "people", text: "Mia wants Google Docs" },
          ],
        })
      : null
  );
  await addNote(w, "people", "Mia likes email");
  w.say("Mia wants drafts as Google Docs");
  const before = await w.files();
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("failed");
  expect(await w.files()).toEqual(before);
});

test("a workspace with no Anthropic key fails the run with the reason", async () => {
  const w = makeDreamWorld();
  w.setKey(null);
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("failed");
  expect(run.error).toContain("Anthropic API key");
});

test("a note that mentions the never list or holds a secret is left out", async () => {
  const w = makeDreamWorld(({ kind }) =>
    kind === "extract"
      ? JSON.stringify({
          notes: [
            {
              evidence: ["e1"],
              kind: "people",
              text: "Mia has a health details file",
            },
            {
              evidence: ["e1"],
              kind: "work",
              text: "The key is sk-ant-abcdefghijklmnopqrstuvwxyz",
            },
            {
              evidence: ["e1"],
              kind: "places",
              text: "Invoices live in the Sales sheet",
            },
          ],
        })
      : JSON.stringify({ conflicts: [], finished: [], groups: [] })
  );
  w.say("Lots of things");
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  const notes = await w.service.list(w.owner, { agentId: AGENT });
  expect(notes.map((item) => item.text)).toEqual([
    "Invoices live in the Sales sheet",
  ]);
});

test("a private conversation's note goes to that person's file and the diary keeps its words out", async () => {
  const w = makeDreamWorld(({ kind }) =>
    kind === "extract"
      ? JSON.stringify({
          notes: [
            {
              evidence: ["e1"],
              kind: "people",
              text: "Priya owns the newsletter list",
            },
          ],
        })
      : JSON.stringify({ conflicts: [], finished: [], groups: [] })
  );
  w.say("Priya owns the newsletter list", SESSION.privateA);
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(run.diary).not.toContain("Priya");
  const forA = await w.service.list(person(USER_A), { agentId: AGENT });
  expect(forA.map((item) => [item.text, item.userScope])).toEqual([
    ["Priya owns the newsletter list", USER_A],
  ]);
  // The owner is not that person: the note is theirs alone.
  const forOwner = await w.service.list(w.owner, { agentId: AGENT });
  expect(forOwner).toHaveLength(0);
});

const askedWorld = async () => {
  const w = makeDreamWorld(({ kind, prompt }) => {
    if (kind === "reconcile") {
      const ids = [...prompt.matchAll(/id=(\S+)/g)].map((match) => match[1]);
      return ids.length >= 2
        ? JSON.stringify({
            conflicts: [{ confidence: 0.9, ids, question: "Which is right?" }],
          })
        : JSON.stringify({ conflicts: [] });
    }
    return kind === "extract"
      ? JSON.stringify({ notes: [] })
      : JSON.stringify({ finished: [], groups: [] });
  });
  const first = await addNote(w, "places", "The coffee machine is on level 2");
  const second = await addNote(w, "places", "The coffee machine is on level 3");
  w.say("Where is the coffee machine?");
  const run = await w.dream.runNow(w.owner, AGENT);
  const [asked] = await w.db.select().from(dreamQuestions);
  return { first, question: defined(asked), run, second, w };
};

test("answering a question keeps the chosen note and forgets the other, either way", async () => {
  for (const keepFirst of [true, false]) {
    // biome-ignore lint/performance/noAwaitInLoops: each way starts its own world
    const { first, question, second, w } = await askedWorld();
    expect(question.status).toBe("open");
    const keep = keepFirst ? first : second;
    const drop = keepFirst ? second : first;

    const answered = await w.dream.answer(w.owner, {
      noteId: keep,
      questionId: question.id,
    });

    expect(answered.status).toBe("answered");
    expect(answered.answeredNoteId).toBe(keep);
    const ids = (await w.service.list(w.owner, { agentId: AGENT })).map(
      (item) => item.id
    );
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
    await expect(
      w.dream.answer(w.owner, { noteId: keep, questionId: question.id })
    ).rejects.toMatchObject({ code: "conflict" });
  }
});

test("a member cannot answer a question about shared notes: nothing is forgotten and the question stays open", async () => {
  const { first, question, second, w } = await askedWorld();

  await expect(
    w.dream.answer(person(USER_B), {
      noteId: first,
      questionId: question.id,
    })
  ).rejects.toMatchObject({ code: "forbidden" });

  const ids = (await w.service.list(w.owner, { agentId: AGENT })).map(
    (item) => item.id
  );
  expect(ids).toEqual(expect.arrayContaining([first, second]));
  const [stored] = await w.db.select().from(dreamQuestions);
  expect(stored?.status).toBe("open");
});

test("the backup owner answers a question about shared notes", async () => {
  const { first, question, second, w } = await askedWorld();
  await w.db
    .update(agents)
    .set({ backupUserId: USER_A })
    .where(eq(agents.id, AGENT))
    .run();

  const answered = await w.dream.answer(person(USER_A), {
    noteId: second,
    questionId: question.id,
  });

  expect(answered.status).toBe("answered");
  expect(answered.answeredNoteId).toBe(second);
  const ids = (await w.service.list(w.owner, { agentId: AGENT })).map(
    (item) => item.id
  );
  expect(ids).toContain(second);
  expect(ids).not.toContain(first);
});

test("an org admin answers a question about shared notes", async () => {
  const { first, question, second, w } = await askedWorld();

  const answered = await w.dream.answer(person(USER_B, { isAdmin: true }), {
    noteId: first,
    questionId: question.id,
  });

  expect(answered.status).toBe("answered");
  expect(answered.answeredNoteId).toBe(first);
  const ids = (await w.service.list(w.owner, { agentId: AGENT })).map(
    (item) => item.id
  );
  expect(ids).toContain(first);
  expect(ids).not.toContain(second);
});

test("a question names one of its notes, and the same pair is not asked twice", async () => {
  const { first, question, run, w } = await askedWorld();
  await expect(
    w.dream.answer(w.owner, {
      noteId: "not-a-note",
      questionId: question.id,
    })
  ).rejects.toMatchObject({ code: "invalid" });
  w.say("Still wondering about the coffee machine");
  const again = await w.dream.runNow(w.owner, AGENT);
  expect(again.id).not.toBe(run.id);
  expect(again.counts.questions).toBe(0);
  expect(await w.db.select().from(dreamQuestions)).toHaveLength(1);
  expect(first).toBeTruthy();
});

test("a question about a private note is the note's person's alone", async () => {
  const w = makeDreamWorld(({ kind, prompt }) => {
    if (kind === "reconcile") {
      const ids = [...prompt.matchAll(/id=(\S+)/g)].map((match) => match[1]);
      return ids.length >= 2
        ? JSON.stringify({
            conflicts: [{ confidence: 0.9, ids, question: "Which?" }],
          })
        : JSON.stringify({ conflicts: [] });
    }
    return kind === "extract"
      ? JSON.stringify({ notes: [] })
      : JSON.stringify({ finished: [], groups: [] });
  });
  await w.service.add(person(USER_A), {
    agentId: AGENT,
    kind: "places",
    source: { id: SESSION.privateA, kind: "session" },
    text: "Call box is 12",
  });
  await w.service.add(person(USER_A), {
    agentId: AGENT,
    kind: "places",
    source: { id: SESSION.privateA, kind: "session" },
    text: "Call box is 14",
  });
  w.say("Remind me about the call box", SESSION.privateA);
  await w.dream.runNow(w.owner, AGENT);
  const [asked] = await w.db.select().from(dreamQuestions);
  const question = defined(asked);
  const [option] = JSON.parse(question.options) as { noteId: string }[];
  const first = defined(option);
  await expect(
    w.dream.answer(w.owner, {
      noteId: first.noteId,
      questionId: question.id,
    })
  ).rejects.toMatchObject({ code: "not_found" });
  const answered = await w.dream.answer(person(USER_A), {
    noteId: first.noteId,
    questionId: question.id,
  });
  expect(answered.status).toBe("answered");
});

test("only the owner or an admin on a session starts, undoes or decides a dream", async () => {
  const w = makeDreamWorld();
  const member = person("user_member");
  await expect(w.dream.runNow(member, AGENT)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(w.dream.runNow(person(OWNER), AGENT)).resolves.toMatchObject({
    status: "skipped",
  });
});

test("folding an exact duplicate leaves the keeper's writer and date, and a merge of changed text is the dream's", async () => {
  const w = makeDreamWorld();
  const person1 = await addNote(w, "people", "Tom reads reports on his phone");
  await w.service.add(w.owner, {
    agentId: AGENT,
    kind: "people",
    text: "Tom reads reports on his phone",
  });
  w.say("anything");
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  const notes = await w.service.list(w.owner, { agentId: AGENT });
  expect(notes).toHaveLength(1);
  expect(notes[0]?.id).toBe(person1);
  expect(notes[0]?.writtenBy).toBe("person");
  const changes = await w.dream.changes(w.owner, run.id);
  expect(changes.map((change) => change.action).sort()).toEqual([
    "forget",
    "merge",
  ]);
  expect(new Set(changes.map((change) => change.groupId)).size).toBe(1);
});

test("one dream writes two people's private files in a single library commit", async () => {
  const w = makeDreamWorld((call) => {
    if (call.kind !== "extract") {
      return quietAnswer(call);
    }
    const text = call.prompt.includes("A likes calls")
      ? "A likes calls"
      : "B likes email";
    return JSON.stringify({
      notes: [{ evidence: ["e1"], kind: "people", text }],
    });
  });
  w.say("A likes calls", SESSION.privateA);
  w.say("B likes email", SESSION.privateB);
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  const [forA, forB] = await Promise.all([
    w.service.list(person(USER_A), { agentId: AGENT }),
    w.service.list(person(USER_B), { agentId: AGENT }),
  ]);
  expect(forA.map((item) => item.text)).toEqual(["A likes calls"]);
  expect(forB.map((item) => item.text)).toEqual(["B likes email"]);
  // Each person sees only their own change rows.
  expect(await w.dream.changes(person(USER_A), run.id)).toHaveLength(1);
  expect(await w.dream.changes(person(USER_B), run.id)).toHaveLength(1);
  expect(await w.dream.changes(w.owner, run.id)).toHaveLength(0);
});

const indexText = async (w: ReturnType<typeof makeDreamWorld>) =>
  (await w.files())["index.md"];

test("undo keeps the index in step with the files: a dream that touched only a private file leaves the shared list alone", async () => {
  const w = makeDreamWorld(({ kind }) =>
    kind === "extract"
      ? JSON.stringify({
          notes: [{ evidence: ["e1"], kind: "people", text: "A likes calls" }],
        })
      : JSON.stringify({ conflicts: [], finished: [], groups: [] })
  );
  await addNote(w, "people", "Tom reads reports on his phone");
  const before = await indexText(w);
  w.say("A likes calls", SESSION.privateA);
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  await w.dream.undo(w.owner, run.id);
  expect(await indexText(w)).toBe(before);
  expect(before).toContain("Tom reads reports");
});

test("undo lists a note a person wrote in another file after the dream", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  await addNote(w, "places", "Invoices live in the Sales sheet");
  await w.dream.undo(w.owner, run.id);
  const files = await w.files();
  expect(files["index.md"]).toContain("Invoices live in the Sales sheet");
  expect(files["index.md"]).not.toContain("Mia wants Google Docs");
  expect(files["places.md"]).toContain("Invoices live in the Sales sheet");
});

test("undo keeps a note a person writes between its two reads and reports the conflict", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  // The person's write lands after undo's first read and before its second.
  // Loading the files starts by listing the private folder, which the version
  // check never does, so that call marks the gap whichever read comes first.
  const list = w.library.list.bind(w.library);
  let armed = true;
  w.library.list = async (...args: Parameters<typeof list>) => {
    if (armed) {
      armed = false;
      await addNote(w, "people", "Written while undo was running");
    }
    return await list(...args);
  };
  await expect(w.dream.undo(w.owner, run.id)).rejects.toMatchObject({
    code: "conflict",
  });
  w.library.list = list;
  expect(
    (await w.service.list(w.owner, { agentId: AGENT })).map((item) => item.text)
  ).toContain("Written while undo was running");
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("applied");
});

/** A model that keeps one new note and reports a conflict between each pair of notes it is given. */
const asksAbout =
  (text: string, pairs: readonly (readonly [string, string])[]): Script =>
  (call) => {
    if (call.kind === "reconcile") {
      const pair = pairs.find(([first]) => call.prompt.includes(first));
      return JSON.stringify({
        conflicts: pair
          ? [{ confidence: 0.9, ids: pair, question: `Which of ${pair[0]}?` }]
          : [],
      });
    }
    return keepsOne(text)(call);
  };

const questionStatuses = async (w: ReturnType<typeof makeDreamWorld>) =>
  (await w.db.select().from(dreamQuestions)).map((row) => row.status);

test("undo closes the questions the dream opened", async () => {
  const w = makeDreamWorld();
  const coffee = await addNote(w, "places", "The coffee machine is on level 2");
  const coffeeNow = await addNote(
    w,
    "places",
    "The coffee machine is on level 3"
  );
  w.setScript(asksAbout("Mia wants Google Docs", [[coffee, coffeeNow]]));
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(await questionStatuses(w)).toEqual(["open"]);

  await w.dream.undo(w.owner, run.id);

  const [question] = await w.db.select().from(dreamQuestions);
  expect(question?.status).toBe("answered");
  expect(question?.answeredBy).toBe(OWNER);
  expect(question?.answeredNoteId).toBeNull();
});

test("rejecting a held batch closes the questions that name its held notes and leaves the others open", async () => {
  const w = makeDreamWorld();
  const tom = await addNote(w, "people", "Tom reads reports on his phone");
  const tomAgain = await addNote(w, "people", "Tom likes reports to be short");
  const tomElse = await addNote(w, "people", "Tom reads nothing on Fridays");
  const coffee = await addNote(w, "places", "The coffee machine is on level 2");
  const coffeeNow = await addNote(
    w,
    "places",
    "The coffee machine is on level 3"
  );
  w.setRules({ learnLevel: "ask_first" });
  w.say("Mia wants drafts as Google Docs");
  w.setScript((call) => {
    if (call.kind === "merge") {
      return JSON.stringify({
        groups: [
          {
            confidence: 0.9,
            ids: [tom, tomAgain],
            rationale: "same person",
            text: "Tom reads reports on his phone, so keep them short",
          },
        ],
      });
    }
    return asksAbout("Mia wants Google Docs", [
      [tom, tomElse],
      [coffee, coffeeNow],
    ])(call);
  });
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.heldChanges).toBeGreaterThan(0);
  expect(await questionStatuses(w)).toEqual(["open", "open"]);

  await w.dream.decide(w.owner, { decision: "reject", dreamRunId: run.id });

  const rows = await w.db.select().from(dreamQuestions);
  const statusOf = (noteId: string) =>
    rows.find((row) => row.options.includes(noteId))?.status;
  expect(statusOf(tom)).toBe("answered");
  expect(statusOf(coffee)).toBe("open");
});

test("approving a held batch is refused when a note it touches changed after the dream", async () => {
  const w = makeDreamWorld(keepsOne("Mia wants Google Docs"));
  w.setRules({ learnLevel: "ask_first" });
  w.say("Mia wants drafts as Google Docs");
  const run = await w.dream.runNow(w.owner, AGENT);
  await addNote(w, "people", "Tom reads reports on his phone");
  await expect(
    w.dream.decide(w.owner, { decision: "approve", dreamRunId: run.id })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    (await w.service.list(w.owner, { agentId: AGENT })).map((item) => item.text)
  ).toEqual(["Tom reads reports on his phone"]);
  // The owner can still reject it.
  await w.dream.decide(w.owner, { decision: "reject", dreamRunId: run.id });
  expect((await w.dream.changes(w.owner, run.id))[0]?.status).toBe("rejected");
});

test("each person's notes are measured against the prompt they share with the shared notes, not against everyone's together", async () => {
  const w = makeDreamWorld();
  const long = (label: string) => `${label} ${"x".repeat(400)}`;
  await addNote(w, "work", long("shared 0"));
  await addNote(w, "work", long("shared 1"));
  for (const [user, session] of [
    [USER_A, SESSION.privateA],
    [USER_B, SESSION.privateB],
  ] as const) {
    for (let index = 0; index < 10; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: notes are written in order
      await w.service.add(person(user), {
        agentId: AGENT,
        kind: "places",
        source: { id: session, kind: "session" },
        text: long(`${user} ${index}`),
      });
    }
  }
  w.say("Anything new");
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  expect(w.calls.some((call) => call.kind === "condense")).toBe(false);
});

test("a person's write while the dream is thinking is not written over when the held batch is approved", async () => {
  const w = makeDreamWorld();
  w.setRules({ learnLevel: "ask_first" });
  w.say("Mia wants drafts as Google Docs");
  w.setScript(async (call) => {
    if (call.kind !== "extract") {
      return quietAnswer(call);
    }
    await addNote(w, "people", "Tom reads reports on his phone");
    return JSON.stringify({
      notes: [
        { evidence: ["e1"], kind: "people", text: "Mia wants Google Docs" },
      ],
    });
  });
  const run = await w.dream.runNow(w.owner, AGENT);
  expect(run.status).toBe("done");
  await expect(
    w.dream.decide(w.owner, { decision: "approve", dreamRunId: run.id })
  ).rejects.toMatchObject({ code: "conflict" });
});
