import { expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { dreamRuns } from "@repo/db/schema/dreams";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { and, eq } from "drizzle-orm";
import { AGENT, OWNER, person } from "../memory/test-world.ts";
import type { Clock } from "../runs/types.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { makeDreamWorld } from "./test-dream.ts";
import { DREAM_CRONS, syncDreamTriggers } from "./trigger.ts";

const OTHER = "agent_other";

const liveTrigger = (w: ReturnType<typeof makeDreamWorld>, agentId: string) =>
  w.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.agentId, agentId), eq(triggers.kind, "dream")))
    .all()
    .filter((row) => row.revokedAt === null);

const setTimezone = (w: ReturnType<typeof makeDreamWorld>, timezone: string) =>
  w.db.update(workspaces).set({ timezone }).run();

const setSchedule = (
  w: ReturnType<typeof makeDreamWorld>,
  agentId: string,
  dreamSchedule: string
) =>
  w.db
    .update(agents)
    .set({
      remember: JSON.stringify({
        dreamSchedule,
        learnLevel: "tell_after",
        never: [],
        remember: [],
        shareWithTeam: true,
      }),
    })
    .where(eq(agents.id, agentId))
    .run();

/** A clock the test moves. */
const movableClock = (start: string) => {
  let now = Date.parse(start);
  const clock: Clock = {
    now: () => new Date(now),
    sleep: () => Promise.resolve(),
  };
  return {
    clock,
    set: (iso: string) => {
      now = Date.parse(iso);
    },
  };
};

test("the sync makes one trigger per active agent from its schedule and removes it when the schedule is off", async () => {
  const w = makeDreamWorld();
  setTimezone(w, "UTC");
  setSchedule(w, OTHER, "weekly");
  expect(await w.dream.syncTriggers(SYSTEM_PRINCIPAL)).toBe(2);
  expect(liveTrigger(w, AGENT)[0]?.cron).toBe(DREAM_CRONS.nightly);
  expect(liveTrigger(w, OTHER)[0]?.cron).toBe(DREAM_CRONS.weekly);
  // Already right: nothing more to do.
  expect(await w.dream.syncTriggers(SYSTEM_PRINCIPAL)).toBe(0);
  setSchedule(w, OTHER, "off");
  expect(await w.dream.syncTriggers(SYSTEM_PRINCIPAL)).toBe(1);
  expect(liveTrigger(w, OTHER)).toHaveLength(0);
  // A draft agent gets none.
  w.db
    .update(agents)
    .set({ status: "draft" })
    .where(eq(agents.id, AGENT))
    .run();
  w.db.delete(triggers).where(eq(triggers.agentId, AGENT)).run();
  expect(await w.dream.syncTriggers(SYSTEM_PRINCIPAL)).toBe(0);
  expect(liveTrigger(w, AGENT)).toHaveLength(0);
});

test("changing the dream schedule in the rules changes the trigger at once", async () => {
  const w = makeDreamWorld();
  const rules = {
    dreamSchedule: "weekly" as const,
    learnLevel: "tell_after" as const,
    never: [],
    remember: [],
    shareWithTeam: true,
  };
  await w.service.rules.set(w.owner, { agentId: AGENT, rules });
  expect(liveTrigger(w, AGENT)[0]?.cron).toBe(DREAM_CRONS.weekly);
  await w.service.rules.set(w.owner, {
    agentId: AGENT,
    rules: { ...rules, dreamSchedule: "off" },
  });
  expect(liveTrigger(w, AGENT)).toHaveLength(0);
  await w.service.rules.set(w.owner, {
    agentId: AGENT,
    rules: { ...rules, dreamSchedule: "nightly" },
  });
  expect(liveTrigger(w, AGENT)[0]?.cron).toBe(DREAM_CRONS.nightly);
});

test("a person cannot make or move a dream trigger", async () => {
  const w = makeDreamWorld();
  await w.dream.syncTriggers(SYSTEM_PRINCIPAL);
  expect(liveTrigger(w, AGENT)).toHaveLength(1);
  // Only the system's sync creates one: the person's dream methods start dreams, nothing else.
  await expect(w.dream.syncTriggers(person(OWNER))).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(w.dream.fireDue(person(OWNER))).rejects.toMatchObject({
    code: "forbidden",
  });
});

test("a nightly and a weekly dream fire at 02:00 in the workspace's timezone, across the date line", async () => {
  // Sydney is UTC+11 in November. 02:00 on Sat 21 Nov there is 15:00 UTC on Fri 20 Nov,
  // and Sunday 02:00 is Saturday 15:00 UTC.
  const time = movableClock("2026-11-20T12:00:00.000Z");
  const w = makeDreamWorld(undefined, time.clock);
  setTimezone(w, "Australia/Sydney");
  setSchedule(w, OTHER, "weekly");
  await w.dream.syncTriggers(SYSTEM_PRINCIPAL);
  expect(liveTrigger(w, AGENT)[0]?.nextRunAt).toBe("2026-11-20T15:00:00.000Z");
  expect(liveTrigger(w, OTHER)[0]?.nextRunAt).toBe("2026-11-21T15:00:00.000Z");
  const runsOf = (agentId: string) =>
    w.db.select().from(dreamRuns).where(eq(dreamRuns.agentId, agentId)).all();

  time.set("2026-11-20T14:59:00.000Z");
  expect((await w.dream.fireDue(SYSTEM_PRINCIPAL)).fired).toHaveLength(0);

  time.set("2026-11-20T15:00:30.000Z");
  expect((await w.dream.fireDue(SYSTEM_PRINCIPAL)).fired).toHaveLength(1);
  expect(runsOf(AGENT)).toHaveLength(1);
  expect(runsOf(OTHER)).toHaveLength(0);
  expect(liveTrigger(w, AGENT)[0]?.nextRunAt).toBe("2026-11-21T15:00:00.000Z");
  // The same minute again fires nothing: the slot moved on.
  expect((await w.dream.fireDue(SYSTEM_PRINCIPAL)).fired).toHaveLength(0);

  time.set("2026-11-21T15:00:30.000Z");
  expect((await w.dream.fireDue(SYSTEM_PRINCIPAL)).fired).toHaveLength(2);
  expect(runsOf(AGENT)).toHaveLength(2);
  expect(runsOf(OTHER)).toHaveLength(1);
  expect(liveTrigger(w, AGENT)[0]?.nextRunAt).toBe("2026-11-22T15:00:00.000Z");
  expect(liveTrigger(w, OTHER)[0]?.nextRunAt).toBe("2026-11-28T15:00:00.000Z");
});

test("a workspace that moves timezone gets its trigger moved by the sync", async () => {
  const time = movableClock("2026-11-20T12:00:00.000Z");
  const w = makeDreamWorld(undefined, time.clock);
  setTimezone(w, "America/Los_Angeles");
  await w.dream.syncTriggers(SYSTEM_PRINCIPAL);
  // 02:00 PST on Sat 21 Nov is 10:00 UTC.
  expect(liveTrigger(w, AGENT)[0]?.nextRunAt).toBe("2026-11-21T10:00:00.000Z");
  setTimezone(w, "Europe/London");
  await w.dream.syncTriggers(SYSTEM_PRINCIPAL);
  expect(liveTrigger(w, AGENT)[0]?.nextRunAt).toBe("2026-11-21T02:00:00.000Z");
  expect(liveTrigger(w, AGENT)[0]?.timezone).toBe("Europe/London");
});

test("syncDreamTriggers for one agent leaves the others alone", async () => {
  const w = makeDreamWorld();
  expect(
    await syncDreamTriggers(w.db, new Date("2026-11-20T12:00:00Z"), AGENT)
  ).toBe(1);
  expect(liveTrigger(w, OTHER)).toHaveLength(0);
});
