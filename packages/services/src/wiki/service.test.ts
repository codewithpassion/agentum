import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { libraryLinks } from "@repo/db/schema/library";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { systemClock } from "../runs/types.ts";
import { createWikiLinkIndex, createWikiService } from "./service.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
let db: ReturnType<typeof migrated>;
let library: ReturnType<typeof createLibraryService>;
let wiki: ReturnType<typeof createWikiService>;
const write = (path: string, body: string) =>
  library.write(principal, path, new TextEncoder().encode(body));
beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w",
      createdAt: systemClock.now().toISOString(),
      id: "w",
      name: "Wiki",
      timezone: "UTC",
    })
    .run();
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: async () => null, put: async () => undefined },
      db,
    }),
    linkIndex: createWikiLinkIndex({ db }),
  });
  wiki = createWikiService({ db, library });
});

test("a missing link becomes live on creation; wiki resolution precedes literal library paths", async () => {
  await write(
    "wiki/source.md",
    "# Source\n[[Finance/Month-end]] [[files/invoices]] [[Finance/Month-end]]"
  );
  await write("files/invoices", "invoice");
  expect(
    (await wiki.page(principal, "wiki/source.md")).links.map(
      ({ path, broken }) => [path, broken]
    )
  ).toEqual([
    ["wiki/finance/month-end.md", true],
    ["files/invoices", false],
    ["wiki/finance/month-end.md", true],
  ]);
  await wiki.createPage(principal, "Month-end", "wiki/finance");
  expect((await wiki.page(principal, "wiki/source.md")).links[0]?.broken).toBe(
    false
  );
  expect(
    (await wiki.page(principal, "wiki/finance/month-end.md")).backlinks.map(
      (p) => p.path
    )
  ).toEqual(["wiki/source.md"]);
  expect(db.select().from(libraryLinks).all()).toHaveLength(2);
});

test("backlinks update on edit, source folder move, target move, delete and restore", async () => {
  await wiki.createPage(principal, "Target");
  await write("wiki/folder/source.md", "[[Target]]");
  await library.move(principal, "wiki/folder", "wiki/moved");
  expect(
    (await wiki.page(principal, "wiki/target.md")).backlinks.map((p) => p.path)
  ).toEqual(["wiki/moved/source.md"]);
  await write("wiki/moved/source.md", "no links");
  expect((await wiki.page(principal, "wiki/target.md")).backlinks).toEqual([]);
  await write("wiki/moved/source.md", "[[Target]]");
  await library.move(principal, "wiki/target.md", "wiki/renamed.md");
  expect(
    (await wiki.page(principal, "wiki/moved/source.md")).links[0]?.broken
  ).toBe(true);
  await library.move(principal, "wiki/renamed.md", "wiki/target.md");
  const [version] = await library.versions(principal, "wiki/moved/source.md");
  await library.remove(principal, "wiki/moved", { recursive: true });
  expect((await wiki.page(principal, "wiki/target.md")).backlinks).toEqual([]);
  if (!version) {
    throw new Error("missing version");
  }
  await library.restore(principal, version.id);
  expect((await wiki.page(principal, "wiki/target.md")).backlinks).toHaveLength(
    1
  );
});

test("moves across the wiki boundary and overwrite moves rebuild the index", async () => {
  await wiki.createPage(principal, "Target");
  await write("notes.md", "[[Target]]");
  await library.move(principal, "notes.md", "wiki/source.md");
  expect((await wiki.page(principal, "wiki/target.md")).backlinks).toHaveLength(
    1
  );
  await write("empty.md", "empty");
  await library.move(principal, "empty.md", "wiki/source.md");
  expect((await wiki.page(principal, "wiki/target.md")).backlinks).toEqual([]);
  await write("wiki/source.md", "[[Target]]");
  await library.move(principal, "wiki/source.md", "outside.md");
  expect(db.select().from(libraryLinks).all()).toEqual([]);
});

test("folder tree, title fallback, duplicates, path validation and isolation", async () => {
  await wiki.createPage(principal, "Finance");
  await wiki.createPage(principal, "Month End", "wiki/finance.md");
  await write("wiki/finance/plain.md", "no heading");
  const tree = await wiki.pages(principal);
  const [root] = tree;
  if (!root) {
    throw new Error("Expected the finance page");
  }
  expect(root.path).toBe("wiki/finance.md");
  expect(root.children.map((p) => p.title)).toEqual(["Month End", "plain"]);
  await expect(wiki.createPage(principal, "Finance")).rejects.toMatchObject({
    code: "conflict",
  });
  await expect(wiki.page(principal, "files/invoices")).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(wiki.createPage(principal, " ")).rejects.toMatchObject({
    code: "invalid",
  });
  expect(await wiki.pages({ ...principal, workspaceId: "other" })).toEqual([]);
  await expect(
    wiki.page({ ...principal, workspaceId: "other" }, "wiki/finance.md")
  ).rejects.toMatchObject({ code: "not_found" });
});

test("a failing atomic batch rolls index changes back with the entry", async () => {
  await write("wiki/source.md", "[[Old]]");
  const failing = createLibraryService({
    atomic: async (statements) => {
      await sqliteAtomic(db)([
        ...statements,
        db.insert(workspaces).values({
          clerkOrgId: "duplicate",
          createdAt: "now",
          id: "w",
          name: "duplicate",
          timezone: "UTC",
        }),
      ]);
    },
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: async () => null, put: async () => undefined },
      db,
    }),
    linkIndex: createWikiLinkIndex({ db }),
  });
  await expect(
    failing.write(
      principal,
      "wiki/source.md",
      new TextEncoder().encode("[[New]]")
    )
  ).rejects.toThrow();
  expect(
    db
      .select()
      .from(libraryLinks)
      .all()
      .map((row) => row.target)
  ).toEqual(["Old"]);
});

test("wiki targets require files; literal library directories resolve and wiki pages take precedence", async () => {
  await library.mkdir(principal, "wiki/fake.md");
  await library.mkdir(principal, "files/invoices");
  await write("wiki/source.md", "[[Fake]] [[files/invoices]]");
  const before = await wiki.page(principal, "wiki/source.md");
  expect(before.links.map(({ broken, path }) => ({ broken, path }))).toEqual([
    { broken: true, path: "wiki/fake.md" },
    { broken: false, path: "files/invoices" },
  ]);
  await wiki.createPage(principal, "Invoices", "wiki/files");
  expect((await wiki.page(principal, "wiki/source.md")).links[1]?.path).toBe(
    "wiki/files/invoices.md"
  );
});
