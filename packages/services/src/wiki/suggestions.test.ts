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

const person = { kind: "user", userId: "u", via: "session", workspaceId: "w" } as const;
const run = { kind: "run", agentId: "a", runId: "r", workspaceId: "w" } as const;
const path = "wiki/page.md";
const bytes = (body: string) => new TextEncoder().encode(body);
let db: ReturnType<typeof migrated>;
let blobs: ReturnType<typeof memoryLibraryBlobs>;
let library: ReturnType<typeof createLibraryService>;
let suggestions: ReturnType<typeof createWikiSuggestionsService>;

beforeEach(async () => {
  db = migrated();
  const createdAt = systemClock.now().toISOString();
  db.insert(workspaces).values({ id: "w", clerkOrgId: "org", createdAt, name: "Wiki", timezone: "UTC" }).run();
  db.insert(agents).values({ id: "a", workspaceId: "w", createdAt, createdBy: "u", instructions: "", model: "m", name: "Agent", runtime: "fake", runtimeConfig: "{}", slug: "agent", status: "active" }).run();
  db.insert(sessions).values({ id: "s", workspaceId: "w", agentId: "a", actorId: "u", actorKind: "user", createdAt, origin: "ui" }).run();
  db.insert(runs).values({ id: "r", workspaceId: "w", agentId: "a", actorId: "u", actorKind: "user", createdAt, inputText: "edit", sessionId: "s", status: "running" }).run();
  blobs = memoryLibraryBlobs();
  const deps = { atomic: sqliteAtomic(db), blobs, clock: systemClock, db, events: createEventsService({ db, blobs: { get: async () => null, put: async () => undefined } }) };
  library = createLibraryService({ ...deps, linkIndex: createWikiLinkIndex({ db }) });
  suggestions = createWikiSuggestionsService({ ...deps, library });
  await library.write(person, path, bytes("base"));
});

test("suggest stores bytes and base, emits an event, and supplies diff inputs", async () => {
  await expect(library.write(run, path, bytes("denied"))).rejects.toMatchObject({ code: "forbidden" });
  const row = await suggestions.suggest(run, path, "proposed", "Fix page");
  expect(row.status).toBe("pending");
  expect(row.baseVersionId).toBe((await library.versions(person, path))[0]?.id ?? "missing");
  expect(blobs.objects.get(`w/wiki-suggestions/${row.id}`)?.bytes).toEqual(bytes("proposed"));
  expect(await suggestions.get(person, row.id)).toMatchObject({ baseText: "base", proposedText: "proposed" });
  expect(await suggestions.list(person)).toHaveLength(1);
  expect(db.select().from(eventRows).all().some((e) => e.type === "wiki.suggestion")).toBe(true);
});

for (const edited of [false, true]) {
  test(`accept${edited ? " with edit" : ""} authors the version as the agent and records the approver`, async () => {
    const row = await suggestions.suggest(run, path, "[[Proposed]]", "Fix");
    const result = await suggestions.decide(person, row.id, { accept: true, ...(edited ? { body: "[[Edited]]" } : {}) });
    const [version] = await library.versions(person, path);
    expect(result).toMatchObject({ status: "accepted", decidedBy: "u", resultVersionId: version?.id });
    expect(version).toMatchObject({ authorKind: "agent", authorId: "a", runId: "r" });
    expect(new TextDecoder().decode((await library.read(person, path)).bytes)).toBe(edited ? "[[Edited]]" : "[[Proposed]]");
    expect(db.select().from(libraryLinks).all()[0]?.target).toBe(edited ? "Edited" : "Proposed");
    const event = db.select().from(eventRows).all().find((e) => e.type === "wiki.suggestion.decided");
    expect(event).toMatchObject({ actorKind: "user", actorId: "u" });
    expect(await suggestions.list(person)).toEqual([]);
    await expect(suggestions.decide(person, row.id, { reject: true })).rejects.toMatchObject({ code: "conflict" });
  });
}

test("reject closes without writing a version", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  expect(await suggestions.decide(person, row.id, { reject: true })).toMatchObject({ status: "rejected", decidedBy: "u" });
  expect(await library.versions(person, path)).toHaveLength(1);
  expect(db.select().from(eventRows).all().filter((e) => e.type === "wiki.suggestion.decided")).toHaveLength(1);
});

test("a stale base requires edited text and stays available for review", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  await library.write(person, path, bytes("new base"));
  expect((await suggestions.list(person))[0]?.status).toBe("stale");
  expect(await suggestions.get(person, row.id)).toMatchObject({ baseText: "base", proposedText: "proposed" });
  await expect(suggestions.decide(person, row.id, { accept: true })).rejects.toMatchObject({ code: "conflict" });
  expect(await suggestions.decide(person, row.id, { accept: true, body: "merged" })).toMatchObject({ status: "accepted" });
});

test("a second suggestion replaces the pending or stale proposal", async () => {
  const first = await suggestions.suggest(run, path, "first", "First");
  await library.write(person, path, bytes("changed"));
  const second = await suggestions.suggest(run, path, "second", "Second");
  expect(second.id).not.toBe(first.id);
  expect((await suggestions.list(person)).map((row) => row.id)).toEqual([second.id]);
  expect(db.select().from(wikiSuggestions).all().find((row) => row.id === first.id)?.status).toBe("rejected");
});

test("decisions are people-only, respect read-only credentials and workspace isolation", async () => {
  const row = await suggestions.suggest(run, path, "proposed", "Fix");
  for (const principal of [run, { kind: "system" } as const, { ...person, apiKey: { access: "read", id: "k" } } as const]) {
    await expect(suggestions.decide(principal, row.id, { accept: true })).rejects.toMatchObject({ code: "forbidden" });
  }
  await expect(suggestions.get({ ...person, workspaceId: "other" }, row.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(suggestions.decide({ ...person, workspaceId: "other" }, row.id, { reject: true })).rejects.toMatchObject({ code: "not_found" });
  await expect(suggestions.suggest(person, path, "x", "x")).rejects.toMatchObject({ code: "forbidden" });
  await expect(suggestions.suggest({ ...run, dryRun: true }, path, "x", "x")).rejects.toMatchObject({ code: "forbidden" });
  await expect(suggestions.suggest(run, "notes.md", "x", "x")).rejects.toMatchObject({ code: "invalid" });
});

test("a missing page has an empty base and can be accepted", async () => {
  const row = await suggestions.suggest(run, "wiki/new.md", "new", "New");
  expect(await suggestions.get(person, row.id)).toMatchObject({ baseVersionId: null, baseText: "" });
  expect(await suggestions.decide(person, row.id, { accept: true })).toMatchObject({ status: "accepted" });
});
