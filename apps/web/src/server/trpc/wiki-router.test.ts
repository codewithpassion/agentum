import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

test("wiki procedures create, list and read pages through composition", async () => {
  const db = migrated(["org"]);
  const composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: async () => null, put: async () => undefined },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const caller = appRouter.createCaller(
    await buildContext({ composed, session: { orgId: "org", userId: "user" } })
  );
  const created = await caller.wiki.createPage({ title: "Welcome" });
  expect(created.path).toBe("wiki/welcome.md");
  expect((await caller.wiki.pages())[0]?.title).toBe("Welcome");
  expect((await caller.wiki.page({ path: created.path })).body).toBe(
    "# Welcome\n"
  );
  const anonymous = appRouter.createCaller(
    await buildContext({ composed, session: { userId: null } })
  );
  await expect(anonymous.wiki.pages()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("wiki suggestions are reviewable through tRPC and appear on the desk", async () => {
  const db = migrated(["org"]);
  const composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: async () => null, put: async () => undefined },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const ctx = await buildContext({
    composed,
    session: { orgId: "org", userId: "user" },
  });
  const caller = appRouter.createCaller(ctx);
  if (ctx.principal?.kind !== "user") {
    throw new Error("Expected member");
  }
  const agent = await ctx.services.agents.create(ctx.principal, {
    instructions: "",
    model: "m",
    name: "Wiki agent",
    runtime: "fake",
    runtimeConfig: {},
    slug: "wiki-agent",
  });
  const createdAt = systemClock.now().toISOString();
  db.insert(sessions)
    .values({
      actorId: "user",
      actorKind: "user",
      agentId: agent.id,
      createdAt,
      id: "s",
      origin: "ui",
      workspaceId: ctx.principal.workspaceId,
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "user",
      actorKind: "user",
      agentId: agent.id,
      createdAt,
      id: "r",
      inputText: "Edit wiki",
      sessionId: "s",
      status: "running",
      workspaceId: ctx.principal.workspaceId,
    })
    .run();
  const page = await caller.wiki.createPage({ title: "Welcome" });
  const suggestion = await ctx.services.wikiSuggestions.suggest(
    {
      agentId: agent.id,
      kind: "run",
      runId: "r",
      workspaceId: ctx.principal.workspaceId,
    },
    page.path,
    "# New welcome",
    "Improve welcome"
  );
  expect(await caller.wiki.suggestions.list()).toHaveLength(1);
  expect(
    await caller.wiki.suggestions.get({ id: suggestion.id })
  ).toMatchObject({ baseText: "# Welcome\n", proposedText: "# New welcome" });
  const desk = await ctx.services.desk.get(ctx.principal, {
    dayStart: "2026-10-27T00:00:00.000Z",
  });
  expect(desk.needsYou).toContainEqual(
    expect.objectContaining({
      id: suggestion.id,
      kind: "proposal",
      needsYouKind: "wiki_suggestion",
    })
  );
  expect(await ctx.services.desk.needsYouCount(ctx.principal)).toBe(
    desk.needsYou.length
  );
  expect(
    await caller.wiki.suggestions.decide({
      accept: true,
      body: "# Edited welcome",
      id: suggestion.id,
    })
  ).toMatchObject({ status: "accepted" });
  expect((await caller.wiki.page({ path: page.path })).body).toBe(
    "# Edited welcome"
  );
  expect(await caller.wiki.suggestions.list()).toEqual([]);
  const anonymous = appRouter.createCaller(
    await buildContext({ composed, session: { userId: null } })
  );
  await expect(anonymous.wiki.suggestions.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
