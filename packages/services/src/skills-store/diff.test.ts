import { describe, expect, test } from "bun:test";
import { isTextBytes, unifiedDiff } from "./diff.ts";

interface Line {
  eol: boolean;
  text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function toLines(text: string): Line[] {
  if (text === "") {
    return [];
  }
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNewline) {
    parts.pop();
  }
  return parts.map((part, index) => ({
    eol: endsWithNewline || index < parts.length - 1,
    text: part,
  }));
}

function lineAt(lines: Line[], index: number): Line {
  const line = lines[index];
  if (!line) {
    throw new Error(`no line at index ${index}`);
  }
  return line;
}

/** Applies a unified diff from this file's tests. It throws when a context or removed line does not match. */
function applyDiff(before: string | null, diff: string): string {
  const old = before === null ? [] : toLines(before);
  const rows = diff.split("\n");
  if (rows.at(-1) === "") {
    rows.pop();
  }
  const out: Line[] = [];
  let pos = 0;
  let index = 0;

  while (index < rows.length) {
    const header = HUNK_HEADER.exec(rows[index] ?? "");
    index += 1;
    if (!header) {
      continue;
    }
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const target = oldCount === 0 ? oldStart : oldStart - 1;
    if (pos > target) {
      throw new Error(`hunk at ${oldStart} overlaps the previous hunk`);
    }
    while (pos < target) {
      out.push(lineAt(old, pos));
      pos += 1;
    }

    let previous = "";
    while (index < rows.length && !(rows[index] ?? "").startsWith("@@")) {
      const row = rows[index] ?? "";
      index += 1;
      const tag = row.charAt(0);
      const content = row.slice(1);
      if (tag === "\\") {
        const last = out.at(-1);
        if (last && previous !== "-") {
          out[out.length - 1] = { eol: false, text: last.text };
        }
        continue;
      }
      if (tag === " " || tag === "-") {
        const line = lineAt(old, pos);
        if (line.text !== content) {
          throw new Error(`expected "${line.text}" but diff has "${content}"`);
        }
        pos += 1;
        if (tag === " ") {
          out.push({ eol: line.eol, text: content });
        }
      } else if (tag === "+") {
        out.push({ eol: true, text: content });
      } else {
        throw new Error(`unknown diff row: ${row}`);
      }
      previous = tag;
    }
  }

  while (pos < old.length) {
    out.push(lineAt(old, pos));
    pos += 1;
  }
  return out.map((line) => `${line.text}${line.eol ? "\n" : ""}`).join("");
}

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function joinLines(lines: string[], trailingNewline = true): string {
  if (lines.length === 0) {
    return "";
  }
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Linear congruential generator. The same seed always gives the same sequence. */
function seededRandom(seed: number): () => number {
  const modulus = 4_294_967_296;
  let state = seed % modulus;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % modulus;
    return state / modulus;
  };
}

function headersOf(diff: string): string[] {
  return diff.split("\n").filter((row) => row.startsWith("@@"));
}

describe("unifiedDiff", () => {
  test("equal texts give an empty string", () => {
    expect(unifiedDiff("a.md", "one\ntwo\n", "one\ntwo\n")).toBe("");
    expect(unifiedDiff("a.md", null, null)).toBe("");
  });

  test("an added file diffs from /dev/null", () => {
    expect(unifiedDiff("a.md", null, "one\ntwo\nthree\n")).toBe(
      [
        "--- /dev/null",
        "+++ b/a.md",
        "@@ -0,0 +1,3 @@",
        "+one",
        "+two",
        "+three",
        "",
      ].join("\n")
    );
  });

  test("a removed file diffs to /dev/null", () => {
    expect(unifiedDiff("a.md", "one\ntwo\n", null)).toBe(
      [
        "--- a/a.md",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "",
      ].join("\n")
    );
  });

  test("a single changed line in a long file gives one hunk with three lines of context", () => {
    const before = joinLines(numbered(20));
    const after = before.replace("line 10\n", "changed\n");
    expect(unifiedDiff("notes.txt", before, after)).toBe(
      [
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -7,7 +7,7 @@",
        " line 7",
        " line 8",
        " line 9",
        "-line 10",
        "+changed",
        " line 11",
        " line 12",
        " line 13",
        "",
      ].join("\n")
    );
  });

  test("two distant changes make two hunks", () => {
    const before = joinLines(numbered(30));
    const after = before
      .replace("line 5\n", "x5\n")
      .replace("line 15\n", "x15\n");
    expect(headersOf(unifiedDiff("f.txt", before, after))).toEqual([
      "@@ -2,7 +2,7 @@",
      "@@ -12,7 +12,7 @@",
    ]);
  });

  test("two close changes merge into one hunk", () => {
    const before = joinLines(numbered(20));
    const after = before
      .replace("line 5\n", "x5\n")
      .replace("line 9\n", "x9\n");
    expect(headersOf(unifiedDiff("f.txt", before, after))).toEqual([
      "@@ -2,11 +2,11 @@",
    ]);
  });

  test("a change at the start and one at the end of the file give two hunks", () => {
    const before = joinLines(numbered(10));
    const after = before
      .replace("line 1\n", "x1\n")
      .replace("line 10\n", "x10\n");
    expect(headersOf(unifiedDiff("f.txt", before, after))).toEqual([
      "@@ -1,4 +1,4 @@",
      "@@ -7,4 +7,4 @@",
    ]);
  });

  test("a missing trailing newline on the new side is marked", () => {
    expect(unifiedDiff("f.txt", "a\nb\nc\n", "a\nb\nc")).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,3 +1,3 @@",
        " a",
        " b",
        "-c",
        "+c",
        "\\ No newline at end of file",
        "",
      ].join("\n")
    );
  });

  test("a missing trailing newline on the old side is marked", () => {
    expect(unifiedDiff("f.txt", "a\nb\nc", "a\nb\nc\n")).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,3 +1,3 @@",
        " a",
        " b",
        "-c",
        "\\ No newline at end of file",
        "+c",
        "",
      ].join("\n")
    );
  });

  test("a file that only gains its final newline is a change", () => {
    const diff = unifiedDiff("f.txt", "a\nb", "a\nb\n");
    expect(applyDiff("a\nb", diff)).toBe("a\nb\n");
    expect(diff).toContain("\\ No newline at end of file");
  });

  test("the fallback block for a middle over 20000 lines still applies to after", () => {
    const before = joinLines(
      Array.from({ length: 25_000 }, (_, index) => `old ${index}`)
    );
    const after = joinLines(
      Array.from({ length: 25_000 }, (_, index) => `new ${index}`)
    );
    const diff = unifiedDiff("big.txt", before, after);
    expect(diff).toContain("-old 0\n");
    expect(diff).toContain("+new 24999\n");
    expect(applyDiff(before, diff)).toBe(after);
  });

  test("the fallback for more than 2000 edits still applies to after", () => {
    const before = joinLines(
      Array.from({ length: 2500 }, (_, index) => `a ${index}`)
    );
    const after = joinLines(
      Array.from({ length: 2500 }, (_, index) => `b ${index}`)
    );
    expect(applyDiff(before, unifiedDiff("f.txt", before, after))).toBe(after);
  });

  test("random line arrays over a small alphabet apply back to after", () => {
    const next = seededRandom(20_260_617);
    const alphabet = ["a", "b", "c", ""];
    const randomLines = (maxLength: number): string[] =>
      Array.from(
        { length: Math.floor(next() * (maxLength + 1)) },
        () => alphabet[Math.floor(next() * alphabet.length)] ?? ""
      );
    const mutate = (lines: string[]): string[] => {
      const result: string[] = [];
      for (const line of lines) {
        const roll = next();
        if (roll < 0.1) {
          continue;
        }
        if (roll < 0.2) {
          result.push(alphabet[Math.floor(next() * alphabet.length)] ?? "");
        }
        result.push(line);
      }
      return result;
    };
    const withRandomNewline = (lines: string[]): string =>
      joinLines(lines, next() < 0.7);

    for (let round = 0; round < 400; round += 1) {
      const beforeLines = randomLines(12);
      const afterLines = next() < 0.5 ? randomLines(12) : mutate(beforeLines);
      const before = withRandomNewline(beforeLines);
      const after = withRandomNewline(afterLines);
      const diff = unifiedDiff("p.txt", before, after);
      expect(applyDiff(before, diff)).toBe(after);
    }
  });
});

describe("isTextBytes", () => {
  test("UTF-8 text is text", () => {
    expect(isTextBytes(new TextEncoder().encode("héllo wörld\n"))).toBe(true);
  });

  test("empty input is text", () => {
    expect(isTextBytes(new Uint8Array())).toBe(true);
  });

  test("bytes with a NUL are not text", () => {
    expect(isTextBytes(Uint8Array.from([0x61, 0x00, 0x62]))).toBe(false);
  });

  test("invalid UTF-8 is not text", () => {
    expect(isTextBytes(Uint8Array.from([0x61, 0xff]))).toBe(false);
  });
});
