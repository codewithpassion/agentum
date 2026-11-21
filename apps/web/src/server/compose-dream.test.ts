import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { NO_KEY_MESSAGE } from "@repo/services/managed/keys";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { composeWith } from "./compose.ts";

const admin: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};

/** A workspace with no Anthropic key, an agent that asks before learning, evidence to dream on and two notes a person wrote that disagree. */
const build = async (devFakeRuntime: boolean) => {
  const db = migrated();
  await db.insert(workspaces).values({
    clerkOrgId: "org_w1",
    createdAt: new Date().toISOString(),
    id: "w1",
    name: "One",
    timezone: "UTC",
  });
  const store = new Map<string, string>();
  const requested: string[] = [];
  const { services } = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: systemClock,
      devFakeRuntime,
      fetch: (url) => {
        requested.push(String(url));
        return Promise.resolve(new Response("{}", { status: 500 }));
      },
      fileBlobs: memoryFileBlobs(),
      publicBaseUrl: "https://hm.test",
      relay: noopRelay,
      secretsKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    },
  });
  const agent = await services.agents.create(admin, {
    model: "m",
    name: "Alpha",
    runtime: "cloud",
  });
  await db
    .update(agents)
    .set({
      remember: JSON.stringify({
        dreamSchedule: "nightly",
        learnLevel: "ask_first",
        never: [],
        remember: [],
        shareWithTeam: true,
      }),
    })
    .where(eq(agents.id, agent.id));
  const at = new Date().toISOString();
  await db.insert(sessions).values({
    actorId: "trigger_1",
    actorKind: "trigger",
    agentId: agent.id,
    createdAt: at,
    id: "s1",
    origin: "trigger",
    private: false,
    workspaceId: "w1",
  });
  await db.insert(runs).values({
    actorId: "trigger_1",
    actorKind: "trigger",
    agentId: agent.id,
    createdAt: at,
    id: "r1",
    inputText: "hi",
    onBehalfOfUserId: null,
    sessionId: "s1",
    status: "running",
    workspaceId: "w1",
  });
  await db.insert(events).values({
    actorId: "u1",
    actorKind: "user",
    agentId: agent.id,
    createdAt: at,
    id: "ev1",
    payload: JSON.stringify({ text: "Please keep the board meeting dates." }),
    runId: "r1",
    sessionId: "s1",
    type: "message.user",
    workspaceId: "w1",
  });
  for (const text of [
    "The board meets on the first Monday of every month.",
    "The board meets on the second Wednesday of each month.",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: two notes, in order
    await services.memory.add(admin, { agentId: agent.id, kind: "work", text });
  }
  return { agent, requested, services };
};

const dreamOnce = async (devFakeRuntime: boolean) => {
  const { agent, requested, services } = await build(devFakeRuntime);
  const run = await services.dream.runNow(admin, agent.id);
  return { agent, requested, run, services };
};

test("a dev build dreams with no key: a diary, a question and a held batch, the same every time", async () => {
  const first = await dreamOnce(true);
  const second = await dreamOnce(true);

  expect(first.run.status).toBe("done");
  expect(first.run.heldChanges).toBe(2);
  expect(first.run.diary).toContain("wait for your approval");
  expect(first.run.counts.questions).toBe(1);
  expect(first.run.openQuestions).toBe(1);

  expect(second.run.diary).toBe(first.run.diary);
  expect(second.run.heldChanges).toBe(first.run.heldChanges);
  expect(second.run.usage).toEqual(first.run.usage);
  expect(first.run.usage?.inputTokens).toBeGreaterThan(0);
  // Nothing went to Anthropic.
  expect(first.requested).toEqual([]);
});

test("a production build refuses the scripted model: with no key the dream fails and calls out to nothing", async () => {
  const { requested, run } = await dreamOnce(false);

  expect(run.status).toBe("failed");
  expect(run.error).toBe(NO_KEY_MESSAGE);
  expect(run.heldChanges).toBe(0);
  expect(requested).toEqual([]);
});
