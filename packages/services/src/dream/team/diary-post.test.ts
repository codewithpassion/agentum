import { expect, test } from "bun:test";
import { dreamRuns } from "@repo/db/schema/dreams";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { eq } from "drizzle-orm";
import type { InboxService } from "../../inbox.ts";
import { AGENT, makeWorld, OWNER, WORKSPACE } from "../../memory/test-world.ts";
import type { Clock } from "../../runs/types.ts";
import { TEAM_DIARY_TOPIC } from "./collect.ts";
import { createTeamDiaryPoster } from "./diary-post.ts";

type World = ReturnType<typeof makeWorld>;

const TEAM = "team_sales";
const BARE = "team_bare";
const ARCHIVED = "team_old";
const CREATED = "2026-11-20T09:00:00.000Z";
const SYDNEY = "Australia/Sydney";
/** 02:30 on 21 Nov in Sydney (UTC+11 in November). */
const FINISHED = "2026-11-20T15:30:00.000Z";
/** 08:00 on 21 Nov in Sydney: the first slot after FINISHED. */
const SLOT = "2026-11-20T21:00:00.000Z";
const BEFORE_SLOT = "2026-11-20T20:59:00.000Z";
const TWELVE_HOURS_PAST = "2026-11-21T09:00:00.000Z";
const LATER_SAME_DAY = "2026-11-20T21:01:00.000Z";

type Notice = Parameters<InboxService["postNotice"]>[1];

/** A world with a Sydney workspace, a team led by the scout agent, a lead-less team and an archived team. */
const makeDiaryWorld = () => {
  const w = makeWorld();
  let nowMs = Date.parse(BEFORE_SLOT);
  const clock: Clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  w.db
    .update(workspaces)
    .set({ timezone: SYDNEY })
    .where(eq(workspaces.id, WORKSPACE))
    .run();
  w.db
    .insert(teams)
    .values([
      {
        createdAt: CREATED,
        id: TEAM,
        leadAgentId: AGENT,
        name: "Sales",
        ownerUserId: OWNER,
        rules: "",
        slug: "sales",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: CREATED,
        id: BARE,
        leadAgentId: null,
        name: "Bare",
        ownerUserId: OWNER,
        rules: "",
        slug: "bare",
        workspaceId: WORKSPACE,
      },
      {
        archivedAt: CREATED,
        createdAt: CREATED,
        id: ARCHIVED,
        leadAgentId: AGENT,
        name: "Old",
        ownerUserId: OWNER,
        rules: "",
        slug: "old",
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  return {
    at: (iso: string) => {
      nowMs = Date.parse(iso);
    },
    clock,
    w,
  };
};

/** A fake inbox that records each notice and writes it as a thread and a post, stamped by the clock, as the real one does. */
const fakeInbox = (
  w: World,
  clock: Clock,
  failingTeamId: string | null = null
) => {
  const notices: Notice[] = [];
  const inbox: Pick<InboxService, "postNotice"> = {
    postNotice: (_principal, input) => {
      if (input.teamId === failingTeamId) {
        return Promise.reject(new Error("The room is closed"));
      }
      notices.push(input);
      const threadId = `thread_${notices.length}`;
      w.db
        .insert(inboxThreads)
        .values({
          createdAt: CREATED,
          createdBy: OWNER,
          id: threadId,
          lastPostAt: CREATED,
          openedByAgentId: input.authorAgentId,
          teamId: input.teamId,
          title: input.title,
          workspaceId: WORKSPACE,
        })
        .run();
      w.db
        .insert(inboxPosts)
        .values({
          authorId: input.authorAgentId ?? OWNER,
          authorKind: input.authorAgentId === null ? "user" : "agent",
          createdAt: clock.now().toISOString(),
          id: `post_${notices.length}`,
          text: input.text,
          threadId,
          workspaceId: WORKSPACE,
        })
        .run();
      return Promise.resolve({
        postId: `post_${notices.length}`,
        runs: [],
        threadId,
      });
    },
  };
  return { inbox, notices };
};

const finishDream = (
  w: World,
  id: string,
  teamId: string,
  diary: string,
  finishedAt = FINISHED
) =>
  w.db
    .insert(dreamRuns)
    .values({
      diary,
      finishedAt,
      id,
      startedAt: new Date(Date.parse(finishedAt) - 60_000).toISOString(),
      status: "done",
      teamId,
      workspaceId: WORKSPACE,
    })
    .run();

test("a diary posts at 08:00 in the workspace timezone, not before", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_sales", TEAM, "Diary one");
  const poster = createTeamDiaryPoster({ clock, db: w.db, inbox });
  expect(await poster.postDue()).toEqual({ posted: [] });
  expect(notices).toEqual([]);
  at(SLOT);
  expect(await poster.postDue()).toEqual({ posted: ["run_sales"] });
  expect(notices).toHaveLength(1);
});

test("a second postDue right after posts nothing", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_sales", TEAM, "Diary one");
  const poster = createTeamDiaryPoster({ clock, db: w.db, inbox });
  at(SLOT);
  await poster.postDue();
  at(LATER_SAME_DAY);
  expect(await poster.postDue()).toEqual({ posted: [] });
  expect(notices).toHaveLength(1);
});

test("the diary is authored by the lead agent in the Team diary topic", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_sales", TEAM, "Diary one");
  at(SLOT);
  await createTeamDiaryPoster({ clock, db: w.db, inbox }).postDue();
  expect(notices).toEqual([
    {
      authorAgentId: AGENT,
      teamId: TEAM,
      text: "Diary one",
      title: TEAM_DIARY_TOPIC,
    },
  ]);
  const rows = w.db
    .select({
      teamId: inboxThreads.teamId,
      text: inboxPosts.text,
      title: inboxThreads.title,
    })
    .from(inboxPosts)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
    .all();
  expect(rows).toEqual([
    { teamId: TEAM, text: "Diary one", title: TEAM_DIARY_TOPIC },
  ]);
});

test("a team with no lead posts its diary as the system", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_bare", BARE, "Bare diary");
  at(SLOT);
  expect(
    await createTeamDiaryPoster({ clock, db: w.db, inbox }).postDue()
  ).toEqual({ posted: ["run_bare"] });
  expect(notices).toEqual([
    {
      authorAgentId: null,
      teamId: BARE,
      text: "Bare diary",
      title: TEAM_DIARY_TOPIC,
    },
  ]);
});

test("a diary more than 12 hours past its slot is dropped", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_sales", TEAM, "Late diary");
  at(TWELVE_HOURS_PAST);
  expect(
    await createTeamDiaryPoster({ clock, db: w.db, inbox }).postDue()
  ).toEqual({ posted: [] });
  expect(notices).toEqual([]);
});

test("an archived team posts nothing", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock);
  finishDream(w, "run_old", ARCHIVED, "Old diary");
  at(SLOT);
  expect(
    await createTeamDiaryPoster({ clock, db: w.db, inbox }).postDue()
  ).toEqual({ posted: [] });
  expect(notices).toEqual([]);
});

test("a failing post for one team does not stop another team's diary", async () => {
  const { at, clock, w } = makeDiaryWorld();
  const { inbox, notices } = fakeInbox(w, clock, TEAM);
  finishDream(w, "run_sales", TEAM, "Sales diary");
  finishDream(w, "run_bare", BARE, "Bare diary");
  at(SLOT);
  expect(
    await createTeamDiaryPoster({ clock, db: w.db, inbox }).postDue()
  ).toEqual({ posted: ["run_bare"] });
  expect(notices.map((notice) => notice.teamId)).toEqual([BARE]);
});
