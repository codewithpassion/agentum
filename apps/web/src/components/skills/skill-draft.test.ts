import { describe, expect, test } from "bun:test";
import {
  changes,
  draftFileSize,
  emptyDraft,
  stageDelete,
  stageWrite,
  toCommitInput,
  treePaths,
} from "./skill-draft.ts";

const text = (data: string) => ({ data, encoding: "text" as const });
const base = new Set(["SKILL.md", "scripts/run.ts", "docs/a.md"]);

describe("emptyDraft", () => {
  test("has no writes and no deletes", () => {
    const draft = emptyDraft();
    expect(draft.writes.size).toBe(0);
    expect(draft.deletes.size).toBe(0);
  });

  test("an empty draft changes nothing and keeps the base tree", () => {
    const draft = emptyDraft();
    expect(changes(base, draft)).toEqual([]);
    expect(treePaths(base, draft)).toEqual([
      "SKILL.md",
      "docs/a.md",
      "scripts/run.ts",
    ]);
    expect(toCommitInput("skill-1", 3, "  msg  ", draft)).toEqual({
      baseVersion: 3,
      deletes: [],
      message: "msg",
      skillId: "skill-1",
      writes: [],
    });
  });
});

describe("stageWrite", () => {
  test("is immutable: the previous draft is untouched", () => {
    const before = emptyDraft();
    const after = stageWrite(before, "a.md", text("x"));
    expect(before.writes.size).toBe(0);
    expect(after.writes.get("a.md")).toEqual(text("x"));
  });

  test("a write to a base path is a modification", () => {
    const draft = stageWrite(emptyDraft(), "SKILL.md", text("new"));
    expect(changes(base, draft)).toEqual([
      { kind: "modified", path: "SKILL.md" },
    ]);
  });

  test("a write to a new path is an addition", () => {
    const draft = stageWrite(emptyDraft(), "scripts/new.ts", text(""));
    expect(changes(base, draft)).toEqual([
      { kind: "added", path: "scripts/new.ts" },
    ]);
    expect(treePaths(base, draft)).toContain("scripts/new.ts");
  });

  test("a write replaces an earlier write to the same path", () => {
    const draft = stageWrite(
      stageWrite(emptyDraft(), "a.md", text("one")),
      "a.md",
      text("two")
    );
    expect(draft.writes.get("a.md")).toEqual(text("two"));
    expect(draft.writes.size).toBe(1);
  });

  test("re-adding a deleted base file turns the delete into a modification", () => {
    const deleted = stageDelete(emptyDraft(), "docs/a.md", base);
    const restored = stageWrite(deleted, "docs/a.md", text("back"));
    expect(restored.deletes.has("docs/a.md")).toBe(false);
    expect(changes(base, restored)).toEqual([
      { kind: "modified", path: "docs/a.md" },
    ]);
    expect(treePaths(base, restored)).toContain("docs/a.md");
  });
});

describe("stageDelete", () => {
  test("a base path is removed from the tree and marked deleted", () => {
    const draft = stageDelete(emptyDraft(), "scripts/run.ts", base);
    expect(draft.deletes.has("scripts/run.ts")).toBe(true);
    expect(treePaths(base, draft)).not.toContain("scripts/run.ts");
    expect(changes(base, draft)).toEqual([
      { kind: "deleted", path: "scripts/run.ts" },
    ]);
  });

  test("deleting a base file that was modified leaves only the delete", () => {
    const modified = stageWrite(emptyDraft(), "SKILL.md", text("edit"));
    const draft = stageDelete(modified, "SKILL.md", base);
    expect(draft.writes.has("SKILL.md")).toBe(false);
    expect(changes(base, draft)).toEqual([
      { kind: "deleted", path: "SKILL.md" },
    ]);
  });

  test("deleting a file added in this draft just drops its write", () => {
    const added = stageWrite(emptyDraft(), "new.md", text("x"));
    const draft = stageDelete(added, "new.md", base);
    expect(draft.writes.has("new.md")).toBe(false);
    expect(draft.deletes.size).toBe(0);
    expect(changes(base, draft)).toEqual([]);
    expect(treePaths(base, draft)).not.toContain("new.md");
  });

  test("is immutable", () => {
    const before = emptyDraft();
    stageDelete(before, "SKILL.md", base);
    expect(before.deletes.size).toBe(0);
  });
});

describe("treePaths and changes", () => {
  test("paths are sorted and deletes are left out", () => {
    let draft = stageWrite(emptyDraft(), "b-new.md", text(""));
    draft = stageWrite(draft, "a-new.md", text(""));
    draft = stageDelete(draft, "docs/a.md", base);
    expect(treePaths(base, draft)).toEqual([
      "SKILL.md",
      "a-new.md",
      "b-new.md",
      "scripts/run.ts",
    ]);
  });

  test("changes are sorted by path and carry their kind", () => {
    let draft = stageWrite(emptyDraft(), "z.md", text(""));
    draft = stageDelete(draft, "SKILL.md", base);
    draft = stageWrite(draft, "docs/a.md", text("y"));
    expect(changes(base, draft)).toEqual([
      { kind: "deleted", path: "SKILL.md" },
      { kind: "modified", path: "docs/a.md" },
      { kind: "added", path: "z.md" },
    ]);
  });
});

describe("draftFileSize", () => {
  test("counts text in UTF-8 bytes", () => {
    expect(draftFileSize(text(""))).toBe(0);
    expect(draftFileSize(text("hé"))).toBe(3);
  });

  test("decodes the size of base64 from its length and padding", () => {
    expect(draftFileSize({ data: "", encoding: "base64" })).toBe(0);
    expect(draftFileSize({ data: "aGVsbG8=", encoding: "base64" })).toBe(5);
    expect(draftFileSize({ data: "aGk=", encoding: "base64" })).toBe(2);
    expect(draftFileSize({ data: "aGVs", encoding: "base64" })).toBe(3);
  });
});

describe("toCommitInput", () => {
  test("maps writes and deletes to the commit input, sorted, with the message trimmed", () => {
    let draft = stageWrite(emptyDraft(), "scripts/new.bin", {
      data: "AAEC",
      encoding: "base64",
    });
    draft = stageWrite(draft, "SKILL.md", text("body"));
    draft = stageDelete(draft, "docs/a.md", base);
    expect(toCommitInput("skill-1", 2, "  Tidy docs \n", draft)).toEqual({
      baseVersion: 2,
      deletes: [{ path: "docs/a.md" }],
      message: "Tidy docs",
      skillId: "skill-1",
      writes: [
        { data: "body", encoding: "text", path: "SKILL.md" },
        { data: "AAEC", encoding: "base64", path: "scripts/new.bin" },
      ],
    });
  });

  test("a deleted added file is not sent at all", () => {
    const added = stageWrite(emptyDraft(), "new.md", text("x"));
    const draft = stageDelete(added, "new.md", base);
    expect(toCommitInput("s", 1, "m", draft)).toEqual({
      baseVersion: 1,
      deletes: [],
      message: "m",
      skillId: "s",
      writes: [],
    });
  });
});
