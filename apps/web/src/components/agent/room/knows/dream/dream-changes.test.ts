import { afterAll, expect, mock, test } from "bun:test";
import type { MemoryChange, MemoryNote } from "@repo/db/shared";
import { serializeMemoryFile } from "@repo/services/memory/codec";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";

interface VersionRead {
  text: string;
  version: { id: string; path: string };
}

interface FakeTrpc {
  dream: {
    changes: {
      query: (input: { dreamRunId: string }) => Promise<MemoryChange[]>;
    };
  };
  library: {
    readVersion: {
      query: (input: { versionId: string }) => Promise<VersionRead>;
    };
    versions: {
      query: (input: {
        path: string;
      }) => Promise<{ id: string; path: string }[]>;
    };
  };
}

// The fake is set per test. The module's getTrpc reads it when a load starts.
let current: FakeTrpc | null = null;
mock.module("#/integrations/trpc/client", () => ({
  getTrpc: (): FakeTrpc => {
    if (current === null) {
      throw new Error("No fake tRPC client is set for this test.");
    }
    return current;
  },
}));

const { loadDreamChanges, noteTextIn, sidesOf } = await import(
  "./dream-changes.ts"
);

// Other test files in this run use the real client, so put it back.
afterAll(() => {
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
});

const NOTE_ID = "01HZ7KQ3M8V2X4R6T9B1C5D0EF";
const OTHER_ID = "01HZ8A2N7PW5G3J6D9K4QS1YXM";
const FILE = "people.md";
const PATH = `agents/scout/memory/${FILE}`;

function fileWith(text: string, id = NOTE_ID): string {
  const note: MemoryNote = {
    date: "2026-11-02",
    id,
    kind: "people",
    source: null,
    text,
    userScope: null,
    writtenBy: "agent",
  };
  return serializeMemoryFile(FILE, [note]);
}

function makeChange(overrides: Partial<MemoryChange>): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: "2026-11-19T22:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    dreamRunId: "run-1",
    groupId: null,
    id: "c1",
    kind: "people",
    libraryVersionId: null,
    noteId: NOTE_ID,
    source: null,
    status: "applied",
    text: "New text",
    userScope: null,
    writtenBy: "dream",
    ...overrides,
  };
}

interface FakeOptions {
  changes: MemoryChange[];
  failing?: string[];
  history?: { id: string; path: string }[];
  texts?: Record<string, string>;
}

/** Builds a fake client. `reads` records every version read, in order. */
function fakeTrpc(options: FakeOptions): { reads: string[]; trpc: FakeTrpc } {
  const reads: string[] = [];
  const failing = new Set(options.failing ?? []);
  const trpc: FakeTrpc = {
    dream: {
      changes: { query: () => Promise.resolve(options.changes) },
    },
    library: {
      readVersion: {
        query: ({ versionId }: { versionId: string }) => {
          reads.push(versionId);
          const text = options.texts?.[versionId];
          if (failing.has(versionId) || text === undefined) {
            return Promise.reject(new Error(`Cannot read ${versionId}.`));
          }
          return Promise.resolve({
            text,
            version: { id: versionId, path: PATH },
          });
        },
      },
      versions: {
        query: () => Promise.resolve(options.history ?? []),
      },
    },
  };
  return { reads, trpc };
}

test("noteTextIn returns the text of the note with that id", () => {
  expect(noteTextIn(PATH, fileWith("Mia wants drafts"), NOTE_ID)).toBe(
    "Mia wants drafts"
  );
});

test("noteTextIn returns null when the file has no such note", () => {
  expect(noteTextIn(PATH, fileWith("Mia wants drafts"), OTHER_ID)).toBeNull();
});

test("noteTextIn returns null for a malformed file", () => {
  const missingFinalNewline = fileWith("Mia wants drafts").slice(0, -1);
  expect(noteTextIn(PATH, missingFinalNewline, NOTE_ID)).toBeNull();
});

test("noteTextIn compares ids case-insensitively", () => {
  expect(
    noteTextIn(PATH, fileWith("Mia wants drafts"), NOTE_ID.toLowerCase())
  ).toBe("Mia wants drafts");
});

test("sidesOf gives only the after text for add", () => {
  expect(sidesOf(makeChange({ action: "add", text: "New" }), null)).toEqual({
    after: "New",
    before: null,
  });
});

test("sidesOf gives both sides for edit and merge", () => {
  for (const action of ["edit", "merge"] as const) {
    expect(sidesOf(makeChange({ action, text: "New" }), "Old")).toEqual({
      after: "New",
      before: "Old",
    });
    expect(sidesOf(makeChange({ action, text: "New" }), null)).toEqual({
      after: "New",
      before: null,
    });
  }
});

test("sidesOf gives only the before text for forget", () => {
  expect(sidesOf(makeChange({ action: "forget", text: "Gone" }), null)).toEqual(
    { after: null, before: "Gone" }
  );
});

test("loadDreamChanges reads no versions for an add", async () => {
  const { reads, trpc } = fakeTrpc({
    changes: [makeChange({ action: "add", libraryVersionId: "v2" })],
  });
  current = trpc;
  const views = await loadDreamChanges("run-1");
  expect(reads).toEqual([]);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ after: "New text", before: null });
});

test("loadDreamChanges takes the before text from the previous version", async () => {
  const { trpc } = fakeTrpc({
    changes: [makeChange({ action: "edit", libraryVersionId: "v2" })],
    history: [
      { id: "v2", path: PATH },
      { id: "v1", path: PATH },
    ],
    texts: {
      v1: fileWith("Old text"),
      v2: fileWith("New text"),
    },
  });
  current = trpc;
  const views = await loadDreamChanges("run-1");
  expect(views[0]).toMatchObject({ after: "New text", before: "Old text" });
});

test("loadDreamChanges leaves before null for an edit with no previous version", async () => {
  const { reads, trpc } = fakeTrpc({
    changes: [makeChange({ action: "edit", libraryVersionId: "v1" })],
    history: [{ id: "v1", path: PATH }],
    texts: { v1: fileWith("New text") },
  });
  current = trpc;
  const views = await loadDreamChanges("run-1");
  expect(views[0]).toMatchObject({ after: "New text", before: null });
  expect(reads).toEqual(["v1"]);
});

test("loadDreamChanges keeps the other changes when one version read fails", async () => {
  const { trpc } = fakeTrpc({
    changes: [
      makeChange({ action: "edit", id: "c1", libraryVersionId: "v2" }),
      makeChange({ action: "add", id: "c2", text: "Second" }),
    ],
    failing: ["v2"],
    history: [
      { id: "v2", path: PATH },
      { id: "v1", path: PATH },
    ],
    texts: { v1: fileWith("Old text") },
  });
  current = trpc;
  const views = await loadDreamChanges("run-1");
  expect(views.map((view) => view.change.id)).toEqual(["c1", "c2"]);
  expect(views[0]).toMatchObject({ after: "New text", before: null });
  expect(views[1]).toMatchObject({ after: "Second", before: null });
});

test("loadDreamChanges reads each version once for several changes", async () => {
  const { reads, trpc } = fakeTrpc({
    changes: [
      makeChange({ action: "edit", id: "c1", libraryVersionId: "v2" }),
      makeChange({ action: "edit", id: "c2", libraryVersionId: "v2" }),
    ],
    history: [
      { id: "v2", path: PATH },
      { id: "v1", path: PATH },
    ],
    texts: { v1: fileWith("Old text"), v2: fileWith("New text") },
  });
  current = trpc;
  const views = await loadDreamChanges("run-1");
  expect(views.map((view) => view.before)).toEqual(["Old text", "Old text"]);
  expect([...reads].sort()).toEqual(["v1", "v2"]);
});
