import { describe, expect, test } from "bun:test";
import {
  summarizeEdit,
  summarizeExec,
  summarizeExecFailure,
  summarizeWrite,
} from "./activity";

describe("summarizeWrite", () => {
  test("distinguishes a new file from an overwrite", () => {
    expect(summarizeWrite({ created: true, path: "/a.txt", size: 12 })).toBe(
      "Created /a.txt (12 bytes)"
    );
    expect(summarizeWrite({ created: false, path: "/a.txt", size: 12 })).toBe(
      "Wrote /a.txt (12 bytes)"
    );
  });
});

describe("summarizeEdit", () => {
  test("names the file", () => {
    expect(summarizeEdit({ path: "/notes/plan.md" })).toBe(
      "Edited /notes/plan.md"
    );
  });
});

describe("summarizeExec", () => {
  test("reads like a shell prompt when the command succeeded", () => {
    expect(summarizeExec({ command: "ls -la /", exitCode: 0 })).toBe(
      "$ ls -la /"
    );
  });

  test("calls out a non-zero exit", () => {
    expect(summarizeExec({ command: "false", exitCode: 1 })).toBe(
      "$ false (exit 1)"
    );
  });

  test("flattens a multi-line command onto one line", () => {
    expect(
      summarizeExec({ command: "echo one\n  echo two", exitCode: 0 })
    ).toBe("$ echo one echo two");
  });

  test("shortens a very long command", () => {
    const summary = summarizeExec({ command: "x".repeat(500), exitCode: 0 });
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBeLessThan(140);
  });
});

describe("summarizeExecFailure", () => {
  test("says the command never ran and why", () => {
    expect(summarizeExecFailure({ command: "ls", reason: "no backend" })).toBe(
      "$ ls (failed: no backend)"
    );
  });
});
