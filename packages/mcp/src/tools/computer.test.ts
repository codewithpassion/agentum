import { describe, expect, test } from "bun:test";
import { DESKTOP_MAX_ACTIONS } from "@repo/protocol/computer";
import type { ComputerPort, PortFailure } from "../ports";
import { runSafely } from "../result";
import { computerTools } from "./computer";
import { MAX_FILE_BYTES, MAX_READ_BYTES, TOOL_OUTPUT_MAX_BYTES, truncateText, validatePath, withTruncationNote } from "./computer-support";

const port = (overrides: Partial<ComputerPort> = {}): ComputerPort => ({
  exec: async () => ({ ok: true, exitCode: 0, stdout: "hello", stderr: "" }),
  readFile: async () => ({ ok: true, content: "one two", size: 7 }),
  writeFile: async () => ({ ok: true, created: false, size: 7 }),
  listDir: async () => ({ ok: true, entries: [{ name: "notes", directory: true, size: 0 }] }),
  desktopInput: async () => ({ ok: true }),
  screenshot: async () => ({ ok: true, image: { data: "aGk=", mimeType: "image/png" } }),
  ...overrides,
});
const call = (computer: ComputerPort, name: string, input: unknown = {}) => {
  const tool = computerTools({ computer }, { desktop: true }).find((item) => item.name === name);
  if (!tool) { throw new Error(name); }
  return runSafely(async () => tool.run(tool.inputSchema.parse(input)));
};

describe("computer tools", () => {
  test("capability lists omit native screenshots and takeover", () => {
    expect(computerTools({}, { desktop: true })).toEqual([]);
    const names = computerTools({ computer: port() }, { desktop: false }).map((tool) => tool.name);
    expect(names.sort()).toEqual(["computer_edit_file", "computer_exec", "computer_list_dir", "computer_read_file", "computer_write_file"]);
    expect(computerTools({ computer: port() }, { desktop: true }).map((tool) => tool.name)).toEqual(["computer_exec", "computer_read_file", "computer_write_file", "computer_edit_file", "computer_list_dir", "desktop_input"]);
  });
  test("exec defaults and truncation preserve nonzero exits", async () => {
    const received: unknown[] = [];
    const result = await call(port({ exec: async (input) => { received.push(input); return { ok: true, exitCode: 2, stdout: "é".repeat(TOOL_OUTPUT_MAX_BYTES), stderr: "x".repeat(20_000) }; } }), "computer_exec", { command: "ls" });
    expect(received).toEqual([{ command: "ls", timeout_ms: 30_000 }]);
    expect(result.structuredContent).toMatchObject({ exitCode: 2 });
    expect(JSON.stringify(result.structuredContent)).toContain("truncated: showing the first 16000");
    expect(withTruncationNote(truncateText("aé", 2))).toBe("a\n[truncated: showing the first 1 of 3 bytes]");
  });
  test("normalises paths and refuses traversal, nulls and long paths", async () => {
    for (const path of ["relative", "/a/../b", "/./a", "/a\0b", "/" + "x".repeat(1024), ""]) {
      expect(validatePath(path).ok).toBe(false);
      expect((await call(port(), "computer_read_file", { path })).isError).toBe(true);
    }
    const received: unknown[] = [];
    await call(port({ listDir: async (input) => { received.push(input); return { ok: true, entries: [] }; } }), "computer_list_dir", { path: "//notes///" });
    expect(received).toEqual([{ path: "/notes" }]);
  });
  test("edits exactly one match and validates resulting byte size before writing", async () => {
    const writes: unknown[] = [];
    const computer = port({ writeFile: async (input) => { writes.push(input); return { ok: true, size: input.content.length, created: false }; } });
    expect((await call(computer, "computer_edit_file", { path: "/a", old_string: "one", new_string: "three" })).isError).toBeFalsy();
    expect(writes).toEqual([{ path: "/a", content: "three two" }]);
    for (const old_string of ["", "missing", "o"]) {
      expect((await call(computer, "computer_edit_file", { path: "/a", old_string, new_string: "x" })).isError).toBe(true);
    }
    expect((await call(computer, "computer_edit_file", { path: "/a", old_string: "one", new_string: "é".repeat(MAX_FILE_BYTES) })).isError).toBe(true);
    expect(writes).toHaveLength(1);
  });
  test("bounds commands, timeout, files and desktop action batches", async () => {
    for (const input of [{ command: "" }, { command: "x".repeat(4001) }, { command: "ls", timeout_ms: 600_001 }, { command: "ls", timeout_ms: 0 }]) {
      expect((await call(port(), "computer_exec", input)).isError).toBe(true);
    }
    expect((await call(port(), "computer_write_file", { path: "/a", content: "é".repeat(MAX_FILE_BYTES) })).isError).toBe(true);
    expect((await call(port({ readFile: async () => ({ ok: true, content: "x".repeat(MAX_READ_BYTES + 1), size: MAX_READ_BYTES + 1 }) }), "computer_read_file", { path: "/a" })).isError).toBe(true);
    for (const actions of [[], Array.from({ length: DESKTOP_MAX_ACTIONS + 1 }, () => ({ type: "key", keys: "a" })), [{ type: "mouse_move", x: 1280, y: 0 }], [{ type: "key", keys: "a;ls" }], [{ type: "type", text: "a".repeat(513) }], [{ type: "scroll", x: 0, y: 0, dx: 50, dy: 50 }]]) {
      expect((await call(port(), "desktop_input", { actions })).isError).toBe(true);
    }
    expect((await call(port(), "desktop_input", { actions: [{ type: "key", keys: "ctrl+l" }] })).isError).toBeFalsy();
  });
  test("every typed failure becomes readable guidance", async () => {
    for (const code of ["offline", "desktop_unavailable", "desktop_busy", "human_in_control", "timeout"] as const) {
      const failure: PortFailure = { ok: false, code };
      for (const name of ["computer_exec", "computer_read_file", "computer_write_file", "computer_edit_file", "computer_list_dir", "desktop_input"]) {
        const computer = port({ exec: async () => failure, readFile: async () => failure, writeFile: async () => failure, listDir: async () => failure, desktopInput: async () => failure });
        const args: Record<string, unknown> = name === "computer_exec" ? { command: "ls" } : name === "desktop_input" ? { actions: [{ type: "key", keys: "a" }] } : name === "computer_edit_file" ? { path: "/a", old_string: "one", new_string: "x" } : name === "computer_write_file" ? { path: "/a", content: "hi" } : { path: "/a" };
        const actual = await call(computer, name, args);
        expect(actual.isError).toBe(true);
        expect(JSON.stringify(actual.content)).toContain(code);
        expect(JSON.stringify(actual.content).length).toBeGreaterThan(70);
      }
    }
  });
});
