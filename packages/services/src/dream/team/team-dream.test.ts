import { expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { memoryChanges } from "@repo/db/schema/memory";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { asc, eq } from "drizzle-orm";
import { ForbiddenError } from "../../authz.ts";
import { serializeMemoryFile } from "../../memory/codec.ts";
import { readTeamDigest } from "../../memory/team.ts";
import {
  OWNER,
  person,
  USER_A,
  USER_B,
  WORKSPACE,
} from "../../memory/test-world.ts";
import {
  type Call,
  defined,
  makeDreamWorld,
  type Script,
} from "../test-dream.ts";
import { createTeamDreamRunner } from "./run.ts";
import { teamDreamPrincipal } from "./team.ts";

type World = ReturnType<typeof makeDreamWorld>;

const SCOUT = "agent_scout";
const QUILL = "agent_quill";
const TALLY = "agent_tally";
const MUTE = "agent_mute";
const TEAM = "team_sales";
const BARE = "team_bare";
const FOLDER = "teams/sales";
const CREATED = "2026-11-20T09:00:00.000Z";

const addAgent = (w: World, id: string, slug: string, shareWithTeam = true) =>
  w.db
    .insert(agents)
    .values({
      createdAt: CREATED,
      createdBy: OWNER,
      id,
      instructions: "",
      model: "m",
      name: slug,
      remember: JSON.stringify({
        dreamSchedule: "nightly",
        learnLevel: "tell_after",
        never: [],
        remember: [],
        shareWithTeam,
      }),
      runtime: "fake",
      runtimeConfig: "{}",
      slug,
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();

/** A world with a sales team (lead scout, owner OWNER) of scout, quill, tally and a member that does not share. */
const makeTeamWorld = (script?: Script) => {
  const w = makeDreamWorld(script);
  addAgent(w, QUILL, "quill");
  addAgent(w, TALLY, "tally");
  addAgent(w, MUTE, "mute", false);
  w.db
    .insert(teams)
    .values([
      {
        createdAt: CREATED,
        folderPath: FOLDER,
        id: TEAM,
        leadAgentId: SCOUT,
        name: "Sales",
        ownerUserId: OWNER,
        rules: "",
        slug: "sales",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: CREATED,
        folderPath: "teams/bare",
        id: BARE,
        leadAgentId: null,
        name: "Bare",
        ownerUserId: OWNER,
        rules: "",
        slug: "bare",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: CREATED,
        folderPath: null,
        id: "team_everyone",
        name: "Everyone",
        ownerUserId: null,
        rules: "",
        slug: "everyone",
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  for (const [teamId, ids] of [
    [TEAM, [SCOUT, QUILL, TALLY, MUTE]],
    [BARE, [QUILL, TALLY]],
  ] as const) {
    w.db
      .insert(teamMembers)
      .values(
        ids.map((memberId) => ({
          isHome: false,
          memberId,
          memberKind: "agent" as const,
          teamId,
          workspaceId: WORKSPACE,
        }))
      )
      .run();
  }
  return w;
};

const note = async (
  w: World,
  agentId: string,
  kind: "corrections" | "people" | "places" | "work",
  text: string
) => (await w.service.add(w.owner, { agentId, kind, text })).noteId;

const idsIn = (prompt: string, ...needles: string[]): string[] =>
  needles.flatMap((needle) => {
    const line = prompt.split("\n").find((entry) => entry.includes(needle));
    return line ? [defined(line.split(" | ")[0])] : [];
  });

const answerFor =
  (
    notes: (call: Call) => unknown,
    extra: Partial<Record<Call["kind"], unknown>> = {}
  ): Script =>
  (call) => {
    if (call.kind === "team_notes") {
      return JSON.stringify(notes(call));
    }
    if (call.kind === "team_friction") {
      return JSON.stringify(extra.team_friction ?? { friction: [] });
    }
    if (call.kind === "team_digest") {
      return JSON.stringify(extra.team_digest ?? { digest: "" });
    }
    return JSON.stringify({ groups: [], notes: [] });
  };

const noMatch = { conflicts: [], shared: [] };

const bytesOf = async (w: World, path: string): Promise<string | null> => {
  try {
    const { bytes } = await w.library.read(
      person(OWNER, { dream: true }),
      path
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const teamNotes = (w: World) =>
  w.service.listTeam(person(OWNER), { teamId: TEAM });

test("members that disagree become one question for the team owner, and the answer updates each member", async () => {
  const w = makeTeamWorld(
    answerFor((call) =>
      call.prompt.includes("Tuesday")
        ? {
            conflicts: [
              {
                confidence: 0.9,
                ids: idsIn(call.prompt, "Tuesday", "Monday"),
                question: "Does the report go out Tuesday or Monday?",
              },
            ],
            shared: [],
          }
        : noMatch
    )
  );
  const tuesday = await note(w, SCOUT, "work", "Report goes out Tuesday");
  const monday = await note(w, QUILL, "work", "Report goes out Monday");
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("done");
  expect(run.teamId).toBe(TEAM);
  expect(run.agentId).toBeNull();
  expect(run.counts.questions).toBe(1);
  const [question] = w.db.select().from(dreamQuestions).all();
  const asked = defined(question);
  expect(asked.teamId).toBe(TEAM);
  expect(asked.agentId).toBeNull();
  expect(asked.status).toBe("open");
  expect(asked.question).toContain("Does the report go out Tuesday or Monday?");
  expect(asked.question).toContain("scout");
  // The dream does not decide: both notes are as they were.
  expect(await w.service.list(w.owner, { agentId: QUILL })).toHaveLength(1);
  // Asked again the next night, the open question is not asked twice.
  await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(w.db.select().from(dreamQuestions).all()).toHaveLength(1);

  // Only the team's owner (or an admin) answers.
  await expect(
    w.dream.answer(person(USER_B), { noteId: tuesday, questionId: asked.id })
  ).rejects.toBeInstanceOf(ForbiddenError);
  const answered = await w.dream.answer(person(OWNER), {
    noteId: tuesday,
    questionId: asked.id,
  });
  expect(answered.status).toBe("answered");
  expect(answered.answeredNoteId).toBe(tuesday);
  const quill = defined(
    (await w.service.list(w.owner, { agentId: QUILL })).find(
      (item) => item.id === monday
    )
  );
  expect(quill.text).toBe("Report goes out Tuesday");
  expect(quill.writtenBy).toBe("person");
  const scout = await w.service.list(w.owner, { agentId: SCOUT });
  expect(scout.map((item) => item.text)).toEqual(["Report goes out Tuesday"]);
  const edit = defined(
    w.db
      .select()
      .from(memoryChanges)
      .where(eq(memoryChanges.noteId, monday))
      .all()
      .find((row) => row.action === "edit")
  );
  expect(edit.agentId).toBe(QUILL);
  expect(edit.decidedBy).toBe(OWNER);
  expect(edit.dreamRunId).toBeNull();
});

test("a note three members hold becomes one team note and the copies are forgotten", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: call.prompt.includes("Pipeline")
        ? [
            {
              confidence: 0.95,
              ids: idsIn(call.prompt, "scout", "quill", "tally"),
              text: "Pipeline numbers live in the Sales sheet",
            },
          ]
        : [],
    }))
  );
  await note(w, SCOUT, "places", "Pipeline numbers live in the Sales sheet");
  await note(w, QUILL, "places", "Pipeline numbers are in the Sales sheet");
  await note(w, TALLY, "places", "Pipeline numbers: Sales sheet");
  await note(w, SCOUT, "places", "The coffee machine is on level 3");
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("done");
  expect(run.counts).toMatchObject({ added: 1, dropped: 3 });
  const lifted = await teamNotes(w);
  expect(lifted.map((item) => [item.kind, item.text, item.writtenBy])).toEqual([
    ["places", "Pipeline numbers live in the Sales sheet", "dream"],
  ]);
  for (const agentId of [QUILL, TALLY]) {
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    expect(await w.service.list(w.owner, { agentId })).toEqual([]);
  }
  expect(
    (await w.service.list(w.owner, { agentId: SCOUT })).map((item) => item.text)
  ).toEqual(["The coffee machine is on level 3"]);
  const rows = w.db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.dreamRunId, run.id))
    .orderBy(asc(memoryChanges.id))
    .all();
  expect(rows.map((row) => [row.action, row.teamId])).toEqual([
    ["add", TEAM],
    ["forget", null],
    ["forget", null],
    ["forget", null],
  ]);
  expect(rows.flatMap((row) => row.agentId ?? []).sort()).toEqual(
    [QUILL, SCOUT, TALLY].sort()
  );
  expect(rows.every((row) => row.libraryVersionId !== null)).toBe(true);
  // One library call wrote everything: the diary tells it.
  expect(run.diary).toContain("Added 1 team note and removed 3 member copies");
  expect(run.diary).toContain("Pipeline numbers live in the Sales sheet");
});

test("a team's dreams and its notes are listed for the team page, apart from its members' dreams", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: call.prompt.includes("Pipeline")
        ? [
            {
              confidence: 0.95,
              ids: idsIn(call.prompt, "scout", "quill", "tally"),
              text: "Pipeline numbers live in the Sales sheet",
            },
          ]
        : [],
    }))
  );
  expect(await w.dream.listTeam(person(USER_B), TEAM)).toEqual([]);
  await note(w, SCOUT, "places", "Pipeline numbers live in the Sales sheet");
  await note(w, QUILL, "places", "Pipeline numbers are in the Sales sheet");
  await note(w, TALLY, "places", "Pipeline numbers: Sales sheet");
  const first = await w.dream.runTeamNow(person(OWNER), TEAM);
  const second = await w.dream.runTeamNow(person(OWNER), TEAM);
  const listed = await w.dream.listTeam(person(USER_B), TEAM);
  expect(listed.map((item) => item.id).sort()).toEqual(
    [first.id, second.id].sort()
  );
  expect(listed.every((item) => item.teamId === TEAM)).toBe(true);
  // Another team has none of them, and a team dream is not an agent's.
  expect(await w.dream.listTeam(person(OWNER), BARE)).toEqual([]);
  expect(await w.dream.list(person(OWNER), SCOUT)).toEqual([]);
  expect((await teamNotes(w)).map((item) => item.text)).toEqual([
    "Pipeline numbers live in the Sales sheet",
  ]);
});

test("a fact two members hold is not lifted", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: [
        {
          confidence: 0.95,
          ids: idsIn(call.prompt, "scout", "quill"),
          text: "Pipeline numbers live in the Sales sheet",
        },
      ],
    }))
  );
  await note(w, SCOUT, "places", "Pipeline numbers live in the Sales sheet");
  await note(w, QUILL, "places", "Pipeline numbers are in the Sales sheet");
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.counts).toMatchObject({ added: 0, dropped: 0 });
  expect(await teamNotes(w)).toEqual([]);
});

test("a person's private notes are never read, sent to the model, lifted or changed", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: call.prompt.includes("Sales sheet")
        ? [
            {
              confidence: 0.95,
              ids: idsIn(call.prompt, "scout", "quill", "tally"),
              text: "Pipeline numbers live in the Sales sheet",
            },
          ]
        : [],
    }))
  );
  await note(w, SCOUT, "places", "Pipeline numbers live in the Sales sheet");
  await note(w, QUILL, "places", "Pipeline numbers are in the Sales sheet");
  await note(w, TALLY, "places", "Pipeline numbers: Sales sheet");
  await note(w, MUTE, "places", "The mute agent keeps this to itself");
  // A private file for each sharing member, and the member that does not share.
  const secret = "Anna wants the salary review kept secret";
  const privateFiles: Record<string, string> = {};
  for (const [agentId, slug] of [
    [SCOUT, "scout"],
    [QUILL, "quill"],
    [MUTE, "mute"],
  ] as const) {
    const path = `agents/${slug}/memory/private/${USER_A}.md`;
    privateFiles[path] = serializeMemoryFile(`private/${USER_A}.md`, [
      {
        date: "2026-11-20",
        id: `01HZ0000000000000000000${agentId.length}${slug.length}`
          .slice(0, 26)
          .padEnd(26, "0"),
        kind: "people",
        source: null,
        text: secret,
        userScope: USER_A,
        writtenBy: "person",
      },
    ]);
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    await w.library.writeMemoryFiles(
      {
        dream: true,
        kind: "user",
        userId: "dream:seed",
        via: "session",
        workspaceId: WORKSPACE,
      },
      [{ bytes: new TextEncoder().encode(privateFiles[path] ?? ""), path }],
      () => []
    );
  }
  const before = await Promise.all(
    Object.keys(privateFiles).map((path) =>
      w.library.versions(person(OWNER, { dream: true }), path)
    )
  );
  w.baseBlobs.touched.length = 0;

  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("done");

  // Not one read or write reached a private path, or the member that does not share.
  expect(
    w.baseBlobs.touched.filter((key) => key.includes("/private/"))
  ).toEqual([]);
  expect(
    w.baseBlobs.touched.filter((key) => key.includes("agents/mute/"))
  ).toEqual([]);
  // Nothing private reached a model prompt, the team's notes, the diary or a question.
  for (const call of w.calls) {
    expect(call.prompt).not.toContain(secret);
    expect(call.prompt).not.toContain("mute agent");
  }
  expect(JSON.stringify(await teamNotes(w))).not.toContain(secret);
  expect(run.diary).not.toContain(secret);
  expect(JSON.stringify(w.notices)).not.toContain(secret);
  // The private files are as they were: same bytes, same versions.
  for (const [path, text] of Object.entries(privateFiles)) {
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    expect(await bytesOf(w, path)).toBe(text);
  }
  const after = await Promise.all(
    Object.keys(privateFiles).map((path) =>
      w.library.versions(person(OWNER, { dream: true }), path)
    )
  );
  expect(after.map((versions) => versions.map((v) => v.id))).toEqual(
    before.map((versions) => versions.map((v) => v.id))
  );
  expect(
    w.db
      .select()
      .from(memoryChanges)
      .all()
      .filter((row) => row.userScope !== null)
  ).toEqual([]);
});

test("the team dream's own principal cannot read a private file", async () => {
  const w = makeTeamWorld();
  const path = `agents/scout/memory/private/${USER_A}.md`;
  await w.library.writeMemoryFiles(
    {
      dream: true,
      kind: "user",
      userId: "dream:seed",
      via: "session",
      workspaceId: WORKSPACE,
    },
    [{ bytes: new TextEncoder().encode("# Private notes\n"), path }],
    () => []
  );
  await expect(
    w.library.read(
      teamDreamPrincipal({ id: TEAM, workspaceId: WORKSPACE }),
      path
    )
  ).rejects.toMatchObject({ code: "not_found" });
});

test("the room digest is stored, and only open topics are read", async () => {
  const w = makeTeamWorld(
    answerFor(() => noMatch, {
      team_digest: { digest: "The team chose Monday launches." },
    })
  );
  const seedThread = (id: string, title: string) =>
    w.db
      .insert(inboxThreads)
      .values({
        createdAt: CREATED,
        createdBy: OWNER,
        id,
        lastPostAt: CREATED,
        teamId: TEAM,
        title,
        workspaceId: WORKSPACE,
      })
      .run();
  seedThread("th_open", "Launch");
  seedThread("th_limited", "Hiring");
  seedThread("th_diary", "Team diary");
  w.db
    .insert(inboxThreadMembers)
    .values({
      memberId: OWNER,
      memberKind: "user",
      threadId: "th_limited",
      workspaceId: WORKSPACE,
    })
    .run();
  const post = (id: string, threadId: string, text: string, authorId = OWNER) =>
    w.db
      .insert(inboxPosts)
      .values({
        authorId,
        authorKind: "user",
        createdAt: "2026-11-20T09:30:00.000Z",
        id,
        text,
        threadId,
        workspaceId: WORKSPACE,
      })
      .run();
  post("p1", "th_open", "Launch on Monday, agreed");
  post("p2", "th_limited", "Salary bands for the hire are confidential");
  post("p3", "th_diary", "Earlier diary text");
  post("p4", "th_open", "System text", "system");
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("done");
  const digestCall = defined(
    w.calls.find((call) => call.kind === "team_digest")
  );
  expect(digestCall.prompt).toContain("Launch on Monday, agreed");
  expect(digestCall.prompt).not.toContain("Salary bands");
  expect(digestCall.prompt).not.toContain("Earlier diary text");
  expect(digestCall.prompt).not.toContain("System text");
  const principal = teamDreamPrincipal({ id: TEAM, workspaceId: WORKSPACE });
  expect(await readTeamDigest(w.library, principal, FOLDER)).toBe(
    "The team chose Monday launches."
  );
  expect(run.diary).toContain("Updated the room digest");
});

test("the diary is not posted in the room at dream time, for a team with a lead or without one", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: call.prompt.includes("Sheet")
        ? [
            {
              confidence: 0.9,
              ids: idsIn(call.prompt, "quill", "tally"),
              text: "Sheet",
            },
          ]
        : [],
    }))
  );
  await note(w, QUILL, "places", "Sheet one");
  await note(w, TALLY, "places", "Sheet two");
  const withLead = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(withLead.status).toBe("done");
  expect(withLead.diary).not.toBe("");
  const bare = await w.dream.runTeamNow(person(OWNER), BARE);
  expect(bare.status).toBe("done");
  expect(w.notices).toEqual([]);
});

test("repeated hand-off rework asks the lead to propose a change; with no lead it is only in the diary", async () => {
  const friction = {
    friction: [
      {
        confidence: 0.9,
        count: 4,
        member: "quill",
        redoneBy: "tally",
        summary: "Tally re-formatted Quill's contact lists four times.",
      },
      {
        confidence: 0.9,
        count: 1,
        member: "tally",
        redoneBy: "quill",
        summary: "Once.",
      },
    ],
  };
  const w = makeTeamWorld(
    answerFor(() => noMatch, { team_friction: friction })
  );
  w.db
    .insert(inboxThreads)
    .values({
      createdAt: CREATED,
      createdBy: OWNER,
      id: "th_open",
      lastPostAt: CREATED,
      teamId: TEAM,
      title: "Lists",
      workspaceId: WORKSPACE,
    })
    .run();
  w.db
    .insert(inboxPosts)
    .values({
      authorId: TALLY,
      authorKind: "agent",
      createdAt: "2026-11-20T09:30:00.000Z",
      id: "p1",
      text: "Fixed Quill's list format again",
      threadId: "th_open",
      workspaceId: WORKSPACE,
    })
    .run();
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.diary).toContain(
    "Hand-off: Tally re-formatted Quill's contact lists four times. Asked the lead."
  );
  expect(w.notices.some((notice) => notice.text === run.diary)).toBe(false);
  const ask = defined(w.notices.find((notice) => notice.wake !== undefined));
  expect(ask.wake).toEqual({ agentId: SCOUT, asUserId: OWNER });
  expect(ask.text).toContain("team_propose_change");
  expect(ask.text).toContain(QUILL);
  // The one-off is not a finding.
  expect(w.notices.filter((notice) => notice.wake !== undefined)).toHaveLength(
    1
  );

  // The bare team has no lead: the diary says it, and nobody is asked.
  w.db
    .insert(inboxThreads)
    .values({
      createdAt: CREATED,
      createdBy: OWNER,
      id: "th_bare",
      lastPostAt: CREATED,
      teamId: BARE,
      title: "Lists",
      workspaceId: WORKSPACE,
    })
    .run();
  w.db
    .insert(inboxPosts)
    .values({
      authorId: TALLY,
      authorKind: "agent",
      createdAt: "2026-11-20T09:31:00.000Z",
      id: "p2",
      text: "Fixed Quill's list format again",
      threadId: "th_bare",
      workspaceId: WORKSPACE,
    })
    .run();
  const before = w.notices.length;
  const bare = await w.dream.runTeamNow(person(OWNER), BARE);
  expect(bare.diary).toContain("Hand-off:");
  expect(bare.diary).not.toContain("Asked the lead.");
  expect(
    w.notices.slice(before).filter((notice) => notice.wake !== undefined)
  ).toEqual([]);
});

test("undo puts every file back, the member copies, the team note and the digest", async () => {
  const w = makeTeamWorld(
    answerFor(
      (call) => ({
        conflicts: [],
        shared: call.prompt.includes("Pipeline")
          ? [
              {
                confidence: 0.95,
                ids: idsIn(call.prompt, "scout", "quill", "tally"),
                text: "Pipeline numbers live in the Sales sheet",
              },
            ]
          : [],
      }),
      { team_digest: { digest: "Pipeline moved to the Sales sheet." } }
    )
  );
  const paths = ["scout", "quill", "tally"].map(
    (slug) => `agents/${slug}/memory/places.md`
  );
  const indexes = ["scout", "quill", "tally"].map(
    (slug) => `agents/${slug}/memory/index.md`
  );
  for (const agentId of [SCOUT, QUILL, TALLY]) {
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    await note(
      w,
      agentId,
      "places",
      `Pipeline numbers live in the Sales sheet (${agentId})`
    );
  }
  w.db
    .insert(inboxThreads)
    .values({
      createdAt: CREATED,
      createdBy: OWNER,
      id: "th_open",
      lastPostAt: CREATED,
      teamId: TEAM,
      title: "Pipeline",
      workspaceId: WORKSPACE,
    })
    .run();
  w.db
    .insert(inboxPosts)
    .values({
      authorId: OWNER,
      authorKind: "user",
      createdAt: "2026-11-20T09:30:00.000Z",
      id: "p1",
      text: "Pipeline lives in the Sales sheet now",
      threadId: "th_open",
      workspaceId: WORKSPACE,
    })
    .run();
  const memberBefore = await Promise.all(
    [...paths, ...indexes].map((path) => bytesOf(w, path))
  );
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("done");
  expect(await teamNotes(w)).toHaveLength(1);
  const principal = teamDreamPrincipal({ id: TEAM, workspaceId: WORKSPACE });
  expect(await readTeamDigest(w.library, principal, FOLDER)).not.toBeNull();

  // Only the owner or an admin undoes it.
  await expect(w.dream.undo(person(USER_B), run.id)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  const undone = await w.dream.undo(person(OWNER), run.id);
  expect(undone.status).toBe("undone");
  expect(
    await Promise.all([...paths, ...indexes].map((path) => bytesOf(w, path)))
  ).toEqual(memberBefore);
  expect(await teamNotes(w)).toEqual([]);
  expect(await readTeamDigest(w.library, principal, FOLDER)).toBeNull();
  const rows = w.db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.dreamRunId, run.id))
    .all();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.status === "undone")).toBe(true);
  expect(undone.diary).toContain("undone");
  // Undone twice is refused.
  await expect(w.dream.undo(person(OWNER), run.id)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("undo is refused when a member's notes changed after the dream", async () => {
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: [
        {
          confidence: 0.95,
          ids: idsIn(call.prompt, "scout", "quill", "tally"),
          text: "Pipeline numbers live in the Sales sheet",
        },
      ],
    }))
  );
  for (const agentId of [SCOUT, QUILL, TALLY]) {
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    await note(
      w,
      agentId,
      "places",
      `Pipeline numbers live in the Sales sheet (${agentId})`
    );
  }
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  await note(w, QUILL, "places", "Something new after the dream");
  await expect(w.dream.undo(person(OWNER), run.id)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await teamNotes(w)).toHaveLength(1);
});

test("a dream with nothing new is skipped without a model call", async () => {
  const w = makeTeamWorld();
  expect((await w.dream.runTeamNow(person(OWNER), TEAM)).status).toBe(
    "skipped"
  );
  await note(w, SCOUT, "work", "A fresh note");
  const first = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(first.status).toBe("done");
  const calls = w.calls.length;
  const second = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(second.status).toBe("skipped");
  expect(second.since).toBe(first.startedAt);
  expect(w.calls.length).toBe(calls);
});

test("a failed model call leaves memory as it was and the run failed", async () => {
  const w = makeTeamWorld(() => null);
  await note(w, SCOUT, "work", "A fresh note");
  await note(w, QUILL, "work", "Another fresh note");
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.status).toBe("failed");
  expect(run.error).toBe("A model call failed");
  expect(run.diary).toContain("Team memory is unchanged");
  expect(await teamNotes(w)).toEqual([]);
});

test("only the team's owner or an org admin starts a team dream, and a team with no folder does not dream", async () => {
  const w = makeTeamWorld();
  await expect(w.dream.runTeamNow(person(USER_B), TEAM)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  expect(
    (await w.dream.runTeamNow(person(USER_B, { isAdmin: true }), TEAM)).status
  ).toBe("skipped");
  await expect(
    w.dream.runTeamNow(person(OWNER, { isAdmin: true }), "team_everyone")
  ).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(w.dream.runTeamNow(person(OWNER), "nope")).rejects.toMatchObject(
    { code: "not_found" }
  );
});

test("a live team dream blocks a second one, and a dead one is taken for failed", async () => {
  const w = makeTeamWorld();
  w.db
    .insert(dreamRuns)
    .values({
      id: "live",
      startedAt: new Date(
        Date.parse("2026-11-20T10:00:00.000Z") - 10 * 60_000
      ).toISOString(),
      status: "running",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
  await expect(w.dream.runTeamNow(person(OWNER), TEAM)).rejects.toMatchObject({
    code: "conflict",
  });
  w.db
    .update(dreamRuns)
    .set({ startedAt: "2026-11-19T00:00:00.000Z" })
    .where(eq(dreamRuns.id, "live"))
    .run();
  expect((await w.dream.runTeamNow(person(OWNER), TEAM)).status).toBe(
    "skipped"
  );
  expect(
    defined(w.db.select().from(dreamRuns).where(eq(dreamRuns.id, "live")).get())
      .status
  ).toBe("failed");
});

test("a team dream is held back at the workspace's weekly limit, and tells spend when it ends", async () => {
  const w = makeTeamWorld();
  let over = true;
  const enforced: string[] = [];
  const runner = createTeamDreamRunner({
    atomic: w.atomic,
    clock: w.clock,
    db: w.db,
    fetch: () => Promise.resolve(new Response("{}", { status: 500 })),
    inbox: {
      postNotice: () =>
        Promise.resolve({ postId: "p", runs: [], threadId: "t" }),
    },
    library: w.library,
    managedKeys: {
      resolve: () => Promise.resolve({ apiKey: "k", environmentId: null }),
    },
    spend: {
      enforceWorkspaceCap: (id) => {
        enforced.push(id);
        return Promise.resolve();
      },
      workspaceOver: () => Promise.resolve(over),
    },
  });
  await expect(runner.run(TEAM)).rejects.toMatchObject({ code: "conflict" });
  expect(w.db.select().from(dreamRuns).all()).toEqual([]);
  over = false;
  expect((await runner.run(TEAM)).status).toBe("skipped");
  expect(enforced).toEqual([WORKSPACE]);
});

test("the tick starts a team's dream after its members' dreams, once", async () => {
  const w = makeTeamWorld();
  const system = { kind: "system" } as const;
  // No member has dreamed yet: nothing is due.
  expect((await w.dream.fireDueTeams(system)).fired).toEqual([]);
  await note(w, SCOUT, "work", "A fresh note");
  w.db
    .insert(dreamRuns)
    .values({
      agentId: SCOUT,
      finishedAt: "2026-11-20T10:00:00.000Z",
      id: "member_dream",
      startedAt: "2026-11-20T09:59:00.000Z",
      status: "done",
      workspaceId: WORKSPACE,
    })
    .run();
  const fired = await w.dream.fireDueTeams(system);
  expect(fired.failed).toEqual([]);
  expect(fired.fired).toHaveLength(1);
  expect((await w.dream.fireDueTeams(system)).fired).toEqual([]);
  await expect(w.dream.fireDueTeams(person(OWNER))).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("a member dream that is still to come holds the team dream back", async () => {
  const w = makeTeamWorld();
  const system = { kind: "system" } as const;
  w.db
    .insert(dreamRuns)
    .values({
      agentId: SCOUT,
      id: "member_dream",
      startedAt: "2026-11-20T09:59:00.000Z",
      status: "done",
      workspaceId: WORKSPACE,
    })
    .run();
  w.db
    .insert(dreamRuns)
    .values({
      agentId: QUILL,
      id: "member_running",
      startedAt: "2026-11-20T10:00:00.000Z",
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await w.dream.fireDueTeams(system)).fired).toEqual([]);
  w.db
    .update(dreamRuns)
    .set({ status: "skipped" })
    .where(eq(dreamRuns.id, "member_running"))
    .run();
  expect((await w.dream.fireDueTeams(system)).fired.length).toBeGreaterThan(0);
});

test("a fact on the workspace's never list is not lifted into team memory", async () => {
  const text = "Passwords and keys are in the shared vault";
  const w = makeTeamWorld(
    answerFor((call) => ({
      conflicts: [],
      shared: [
        {
          confidence: 0.95,
          ids: idsIn(call.prompt, "scout", "quill", "tally"),
          text,
        },
      ],
    }))
  );
  for (const agentId of [SCOUT, QUILL, TALLY]) {
    // biome-ignore lint/performance/noAwaitInLoops: seeding in order keeps the note ids and dates stable
    await note(
      w,
      agentId,
      "places",
      `The vault is where the team stores things (${agentId})`
    );
  }
  const run = await w.dream.runTeamNow(person(OWNER), TEAM);
  expect(run.counts).toMatchObject({ added: 0, dropped: 0 });
  expect(await teamNotes(w)).toEqual([]);
  expect(await w.service.list(w.owner, { agentId: SCOUT })).toHaveLength(1);
});

test("a team that cannot start now is skipped by the tick and does not use up its turns", async () => {
  const w = makeTeamWorld();
  const system = { kind: "system" } as const;
  w.db
    .insert(dreamRuns)
    .values({
      agentId: SCOUT,
      id: "member_dream",
      startedAt: "2026-11-20T09:00:00.000Z",
      status: "done",
      workspaceId: WORKSPACE,
    })
    .run();
  w.db
    .insert(dreamRuns)
    .values({
      id: "live",
      startedAt: "2026-11-20T09:59:00.000Z",
      status: "running",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
  const result = await w.dream.fireDueTeams(system);
  expect(result.fired).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(result.skipped.map((item) => item.teamId)).toEqual([TEAM]);
});
