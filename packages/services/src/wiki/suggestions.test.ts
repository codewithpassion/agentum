import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { libraryLinks, wikiSuggestions } from "@repo/db/schema/library";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { systemClock } from "../runs/types.ts";
import { createWikiLinkIndex } from "./service.ts";
import { createWikiSuggestionsService } from "./suggestions.ts";

const person = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
const run = {
  agentId: "a",
  kind: "run",
  runId: "r",
  workspaceId: "w",
} as const;
const path = "wiki/page.md";
const bytes = (body: string) => new TextEncoder().encode(body);
let db: ReturnType<typeof migrated>;
let blobs: ReturnType<typeof memoryLibraryBlobs>;
let library: ReturnType<typeof createLibraryService>;
let suggestions: ReturnType<typeof createWikiSuggestionsService>;

beforeEach(async () => {
  db = migrated();
  const createdAt = systemClock.now().toISOString();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt,
      id: "w",
      name: "Wiki",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values({
      createdAt,
      createdBy: "u",
      id: "a",
      instructions: "",
      model: "m",
      name: "Agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "agent",
      status: "active",
      workspaceId: "w",
    })
    .run();
  db.insert(sessions)
    .values({
      actorId: "u",
      actorKind: "user",
      agentId: "a",
      createdAt,
      id: "s",
      origin: "ui",
      workspaceId: "w",
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u",
      actorKind: "user",
      agentId: "a",
      createdAt,
      id: "r",
      inputText: "edit",
      sessionId: "s",
      status: "running",
      workspaceId: "w",
    })
    .run();
  blobs = memoryLibraryBlobs();
  const deps = {
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: async () => null, put: async () => undefined },
      db,
    }),
  };
  library = createLibraryService({
    ...deps,
    linkIndex: createWikiLinkIndex({ db }),
  });
  suggestions = createWikiSuggestionsService({ ...deps, library });
  await library.write(person, path, bytes("base"));
});

test("suggest stores bytes and base, emits an event, and supplies diff inputs", async () => {
  await expect(library.write(run, path, bytes("denied"))).rejects.toMatchObject(
    { code: "forbidden" }
  );
  const row = await suggestions.suggest(run, path, "proposed", "Fix page");
  expect(row.status).toBe("pending");
  expect(row.baseVersionId).toBe(
    (await library.versions(person, path))[0]?.id ?? "missing"
  );
  expect(blobs.objects.get(`w/wiki-suggestions/${row.id}`)?.bytes).toEqual(
    bytes("proposed")
  );
  expect(await suggestions.get(person, row.id)).toMatchObject({
    baseText: "base",
    currentText: "base",
    proposedText: "proposed",
  });
  expect(await suggestions.list(person)).toHaveLength(1);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .some((e) => e.type === "wiki.suggestion")
  ).toBe(true);
});

for (const edited of [false, true]) {
  test(`accept${edited ? " with edit" : ""} authors the version as the agent and records the approver`, async () => {
    const row = await suggestions.suggest(run, path, "[[Proposed]]", "Fix");
    const result = await suggestions.decide(person, row.id, {
      accept: true,
      ...(edited ? { body: "[[Edited]]" } : {}),
    });
    const [version] = await library.versions(person, path);
    expect(result).toMatchObject({
      decidedBy: "u",
      resultVersionId: version?.id,
      status: "accepted",
    });
    expect(version).toMatchObject({
      authorId: "a",
      authorKind: "agent",
      runId: "r",
    });
    expect(
      new TextDecoder().decode((await library.read(person, path)).bytes)
    ).toBe(edited ? "[[Edited]]" : "[[Proposed]]");
    expect(db.select().from(libraryLinks).all()[0]?.target).toBe(
      edited ? "Edited" : "Proposed"
    );
    const event = db
      .select()
      .from(eventRows)
      .all()
      .find((e) => e.type === "wiki.suggestion.decided");
    expect(event).toMatchObject({ actorId: "u", actorKind: "user" });
    expect(await suggestions.list(person)).toEqual([]);
    await expect(
      suggestions.decide(person, row.id, { reject: true })
    ).rejects.toMatchObject({ code: "conflict" });
  });
}

test("reject closes without writing a version", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  expect(
    await suggestions.decide(person, row.id, { reject: true })
  ).toMatchObject({ decidedBy: "u", status: "rejected" });
  expect(await library.versions(person, path)).toHaveLength(1);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((e) => e.type === "wiki.suggestion.decided")
  ).toHaveLength(1);
});

test("a stale base requires edited text and stays available for review", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  await library.write(person, path, bytes("new base"));
  expect((await suggestions.list(person))[0]?.status).toBe("stale");
  expect(await suggestions.get(person, row.id)).toMatchObject({
    baseText: "base",
    currentText: "new base",
    proposedText: "proposed",
  });
  await expect(
    suggestions.decide(person, row.id, { accept: true })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await suggestions.decide(person, row.id, { accept: true, body: "merged" })
  ).toMatchObject({ status: "accepted" });
});

test("a second suggestion replaces the pending or stale proposal", async () => {
  const first = await suggestions.suggest(run, path, "first", "First");
  await library.write(person, path, bytes("changed"));
  const second = await suggestions.suggest(run, path, "second", "Second");
  expect(second.id).not.toBe(first.id);
  expect((await suggestions.list(person)).map((row) => row.id)).toEqual([
    second.id,
  ]);
  expect(
    db
      .select()
      .from(wikiSuggestions)
      .all()
      .find((row) => row.id === first.id)?.status
  ).toBe("rejected");
});

test("decisions are people-only, respect read-only credentials and workspace isolation", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  await Promise.all(
    [
      run,
      { kind: "system" } as const,
      { ...person, apiKey: { access: "read", id: "k" } } as const,
    ].map((principal) =>
      expect(
        suggestions.decide(principal, row.id, { accept: true })
      ).rejects.toMatchObject({ code: "forbidden" })
    )
  );
  await expect(
    suggestions.get({ ...person, workspaceId: "other" }, row.id)
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    suggestions.decide({ ...person, workspaceId: "other" }, row.id, {
      reject: true,
    })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    suggestions.suggest(person, path, "x", "x")
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    suggestions.suggest({ ...run, dryRun: true }, path, "x", "x")
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    suggestions.suggest(run, "notes.md", "x", "x")
  ).rejects.toMatchObject({ code: "invalid" });
});

test("a missing page has an empty base and can be accepted", async () => {
  const row = await suggestions.suggest(run, "wiki/new.md", "new", "New");
  expect(await suggestions.get(person, row.id)).toMatchObject({
    baseText: "",
    baseVersionId: null,
    currentText: "",
  });
  expect(
    await suggestions.decide(person, row.id, { accept: true })
  ).toMatchObject({ status: "accepted" });
});

test("a deleted page supplies an empty base and a later deletion makes an edit stale", async () => {
  await library.remove(person, path);
  const row = await suggestions.suggest(run, path, "restored", "Restore");
  expect(await suggestions.get(person, row.id)).toMatchObject({
    baseText: "",
    currentText: "",
    proposedText: "restored",
  });
  await suggestions.decide(person, row.id, { accept: true });
  expect(await suggestions.get(person, row.id)).toMatchObject({
    baseText: "",
    currentText: "restored",
  });
  const next = await suggestions.suggest(run, path, "another edit", "Edit");
  await library.remove(person, path);
  expect(await suggestions.get(person, next.id)).toMatchObject({
    baseText: "restored",
    currentText: "",
    status: "stale",
  });
  await expect(
    suggestions.decide(person, next.id, { accept: true })
  ).rejects.toMatchObject({ code: "conflict" });
});

test("concurrent replacements leave one actionable proposal per agent and page", async () => {
  await Promise.all([
    suggestions.suggest(run, path, "one", "One"),
    suggestions.suggest(run, path, "two", "Two"),
  ]);
  expect(await suggestions.list(person)).toHaveLength(1);
});

test("a failed acceptance batch rolls back the version, index, decision and event", async () => {
  const row = await suggestions.suggest(run, path, "[[New]]", "Fix");
  const events = createEventsService({
    blobs: { get: async () => null, put: async () => undefined },
    db,
  });
  const failingLibrary = createLibraryService({
    atomic: (statements) =>
      sqliteAtomic(db)([
        ...statements,
        db.insert(workspaces).values({
          clerkOrgId: "duplicate",
          createdAt: "now",
          id: "w",
          name: "duplicate",
          timezone: "UTC",
        }),
      ]),
    blobs,
    clock: systemClock,
    db,
    events,
    linkIndex: createWikiLinkIndex({ db }),
  });
  const failing = createWikiSuggestionsService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events,
    library: failingLibrary,
  });
  await expect(
    failing.decide(person, row.id, { accept: true })
  ).rejects.toThrow();
  expect(await library.versions(person, path)).toHaveLength(1);
  expect(db.select().from(wikiSuggestions).all()[0]?.status).toBe("pending");
  expect(db.select().from(libraryLinks).all()).toHaveLength(0);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((event) => event.type === "wiki.suggestion.decided")
  ).toHaveLength(0);
});
