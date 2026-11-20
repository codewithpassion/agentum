import { expect, spyOn, test } from "bun:test";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  type MemoryNote,
} from "@repo/db/shared";
import { notFound, ServiceError } from "../errors.ts";
import type { LibraryEntry, LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import { serializeMemoryFile } from "./codec.ts";
import {
  libraryMemoryReader,
  loadPromptMemory,
  MEMORY_PROMPT_MAX_CHARS,
  type MemoryFileReader,
} from "./prompt.ts";

const ulid = (n: number): string =>
  `01HZ7KQ3M8V2X4R6T9B1C5${String(n).padStart(4, "0")}`;

const note = (
  n: number,
  overrides: Partial<MemoryNote> & Pick<MemoryNote, "kind" | "text"> = {
    kind: "people",
    text: "A note",
  }
): MemoryNote => ({
  date: "2026-11-02",
  id: ulid(n),
  source: null,
  userScope: null,
  writtenBy: "person",
  ...overrides,
});

const JSON_RULES = (overrides: object) =>
  JSON.stringify({ ...DEFAULT_REMEMBER_RULES, ...overrides });

const fakeFiles = (files: Record<string, string>) => {
  const calls: string[] = [];
  const read: MemoryFileReader = (path) => {
    calls.push(path);
    return Promise.resolve(files[path] ?? null);
  };
  return { calls, read };
};

const rulesOnly = {
  agentRemember: JSON_RULES({}),
  privateNotesUserId: null,
  workspaceNever: JSON.stringify([]),
};

test("the private file loads only for the person the run acts for", async () => {
  const privateA = serializeMemoryFile("private/user_a1.md", [
    note(1, {
      kind: "people",
      text: "Only Ana sees this",
      userScope: "user_a1",
    }),
  ]);
  const files = { "private/user_a1.md": privateA };

  const forOwner = await loadPromptMemory(fakeFiles(files).read, {
    ...rulesOnly,
    privateNotesUserId: "user_a1",
  });
  expect(forOwner.notes.map((item) => item.id)).toEqual([ulid(1)]);

  const other = fakeFiles(files);
  const forOther = await loadPromptMemory(other.read, {
    ...rulesOnly,
    privateNotesUserId: "user_b2",
  });
  expect(forOther.notes).toEqual([]);
  expect(other.calls).not.toContain("private/user_a1.md");

  const unattended = fakeFiles(files);
  const forNobody = await loadPromptMemory(unattended.read, rulesOnly);
  expect(forNobody.notes).toEqual([]);
  expect(unattended.calls.some((path) => path.startsWith("private/"))).toBe(
    false
  );
});

test("a malformed file is skipped and the other files still load", async () => {
  const files = {
    "corrections.md": serializeMemoryFile("corrections.md", [
      note(1, { kind: "corrections", text: "Send drafts as Docs" }),
    ]),
    "people.md": "# People\n\n- id: broken",
  };

  const memory = await loadPromptMemory(fakeFiles(files).read, rulesOnly);

  expect(memory.notes.map((item) => item.id)).toEqual([ulid(1)]);
});

test("notes stop at the budget and corrections are kept first", async () => {
  const bigPeople = Array.from({ length: 20 }, (_, index) =>
    note(100 + index, { kind: "people", text: "p".repeat(500) })
  );
  const files = {
    "corrections.md": serializeMemoryFile("corrections.md", [
      note(1, { kind: "corrections", text: "c".repeat(200) }),
    ]),
    "people.md": serializeMemoryFile("people.md", bigPeople),
  };

  const memory = await loadPromptMemory(fakeFiles(files).read, rulesOnly);
  const total = memory.notes.reduce((sum, item) => sum + item.text.length, 0);

  expect(total).toBeLessThanOrEqual(MEMORY_PROMPT_MAX_CHARS);
  expect(memory.notes[0]?.kind).toBe("corrections");
  expect(memory.notes.length).toBeLessThan(bigPeople.length + 1);
  expect(memory.notes.length).toBeGreaterThan(1);
});

test("the workspace never list comes before the agent's own", async () => {
  const memory = await loadPromptMemory(fakeFiles({}).read, {
    agentRemember: JSON_RULES({ never: ["Tax file numbers"] }),
    privateNotesUserId: null,
    workspaceNever: JSON.stringify(["Salaries"]),
  });

  expect(memory.never).toEqual(["Salaries", "Tax file numbers"]);
});

test("the agent's remember list is read from its rules", async () => {
  const memory = await loadPromptMemory(fakeFiles({}).read, {
    agentRemember: JSON_RULES({ remember: ["Tables stay short"] }),
    privateNotesUserId: null,
    workspaceNever: JSON.stringify([]),
  });

  expect(memory.remember).toEqual(["Tables stay short"]);
});

test("invalid rules JSON falls back to the defaults", async () => {
  const memory = await loadPromptMemory(fakeFiles({}).read, {
    agentRemember: "{not json",
    privateNotesUserId: null,
    workspaceNever: "not json",
  });

  expect(memory.never).toEqual([...DEFAULT_NEVER_REMEMBER]);
  expect(memory.remember).toEqual(DEFAULT_REMEMBER_RULES.remember);
});

test("JSON of the wrong shape falls back to the defaults", async () => {
  const memory = await loadPromptMemory(fakeFiles({}).read, {
    agentRemember: JSON.stringify({ remember: "not a list" }),
    privateNotesUserId: null,
    workspaceNever: JSON.stringify({ never: "not a list" }),
  });

  expect(memory.never).toEqual([...DEFAULT_NEVER_REMEMBER]);
  expect(memory.remember).toEqual(DEFAULT_REMEMBER_RULES.remember);
});

test("each memory file is read once", async () => {
  const reader = fakeFiles({});

  await loadPromptMemory(reader.read, {
    agentRemember: JSON_RULES({}),
    privateNotesUserId: "user_a1",
    workspaceNever: JSON.stringify([]),
  });

  expect(reader.calls.sort()).toEqual(
    [
      "corrections.md",
      "people.md",
      "places.md",
      "private/user_a1.md",
      "work.md",
    ].sort()
  );
});

const libraryWith = (
  read: (principal: Principal, path: string) => Promise<Uint8Array>
): Pick<LibraryService, "read"> => ({
  read: async (principal, path) => {
    const bytes = await read(principal, path);
    const entry: LibraryEntry = {
      etag: null,
      kind: "file",
      mtime: "2026-11-02T00:00:00.000Z",
      path,
      size: bytes.length,
      updatedBy: { id: "agent", kind: "agent" },
    };
    return { bytes, entry };
  },
});

const RUN = { agentId: "agent_1", id: "run_1", workspaceId: "w1" };

test("the library reader reads the memory file as the run's principal", async () => {
  const seen: { principal: Principal; path: string }[] = [];
  const library = libraryWith((principal, path) => {
    seen.push({ path, principal });
    return Promise.resolve(new TextEncoder().encode("# People\n"));
  });

  const text = await libraryMemoryReader(library, RUN, "scout")("people.md");

  expect(text).toBe("# People\n");
  expect(seen).toEqual([
    {
      path: "agents/scout/memory/people.md",
      principal: {
        agentId: "agent_1",
        kind: "run",
        runId: "run_1",
        workspaceId: "w1",
      },
    },
  ]);
});

test("the library reader returns null for a file that does not exist", async () => {
  const library = libraryWith(() => Promise.reject(notFound()));

  expect(
    await libraryMemoryReader(library, RUN, "scout")("work.md")
  ).toBeNull();
});

test("the library reader treats other errors as a missing file and logs the error name only", async () => {
  const library = libraryWith(() =>
    Promise.reject(new ServiceError("conflict", "secret detail"))
  );
  const log = spyOn(console, "error").mockImplementation(() => undefined);

  expect(
    await libraryMemoryReader(library, RUN, "scout")("work.md")
  ).toBeNull();
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]?.[0])).not.toContain("secret detail");
  log.mockRestore();
});
