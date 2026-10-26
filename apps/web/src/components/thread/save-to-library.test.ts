import { describe, expect, test } from "bun:test";
import { defaultLibraryPath } from "./save-to-library.tsx";

describe("defaultLibraryPath", () => {
  test("builds outputs/<agent>/<file>", () => {
    expect(defaultLibraryPath("Researcher", "report.pdf")).toBe(
      "/outputs/Researcher/report.pdf"
    );
  });

  test("turns slashes in the agent name and the file name into dashes", () => {
    expect(defaultLibraryPath("ops/eu", "2026/q3 notes.md")).toBe(
      "/outputs/ops-eu/2026-q3 notes.md"
    );
  });

  test("falls back to agent for an empty agent name", () => {
    expect(defaultLibraryPath("", "a.txt")).toBe("/outputs/agent/a.txt");
  });

  test("falls back to agent for a blank agent name", () => {
    expect(defaultLibraryPath("   ", "a.txt")).toBe("/outputs/agent/a.txt");
  });
});
