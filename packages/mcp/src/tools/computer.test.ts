import { describe, expect, test } from "bun:test";
import { DESKTOP_MAX_ACTIONS } from "@repo/protocol/computer";
import type { ComputerPort, PortFailure } from "../ports";
import { runSafely } from "../result";
import { computerTools } from "./computer";
import {
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  truncateText,
  validatePath,
  withTruncationNote,
} from "./computer-support";

const port = (overrides: Partial<ComputerPort> = {}): ComputerPort => ({
  desktopInput: async () => ({ ok: true }),
  exec: async () => ({ exitCode: 0, ok: true, stderr: "", stdout: "hello" }),
  listDir: async () => ({
    entries: [{ directory: true, name: "notes", size: 0 }],
    ok: true,
  }),
  readFile: async () => ({ content: "one two", ok: true, size: 7 }),
  screenshot: async () => ({
    image: { data: "aGk=", mimeType: "image/png" },
    ok: true,
  }),
  writeFile: async () => ({ created: false, ok: true, size: 7 }),
  ...overrides,
});
const call = (computer: ComputerPort, name: string, input: unknown = {}) => {
  const tool = computerTools({ computer }, { desktop: true }).find(
    (item) => item.name === name
  );
  if (!tool) {
    throw new Error(name);
  }
  return runSafely(async () => tool.run(tool.inputSchema.parse(input)));
};
describe("computer tools", () => {
  test("capability lists omit native screenshots and takeover", () => {
    expect(computerTools({}, { desktop: true })).toEqual([]);
    const names = computerTools({ computer: port() }, { desktop: false }).map(
      (tool) => tool.name
    );
    expect(names.sort()).toEqual([
      "computer_edit_file",
      "computer_exec",
      "computer_list_dir",
      "computer_read_file",
      "computer_write_file",
    ]);
    expect(
      computerTools({ computer: port() }, { desktop: true }).map(
        (tool) => tool.name
      )
    ).toEqual([
      "computer_exec",
      "computer_read_file",
      "computer_write_file",
      "computer_edit_file",
      "computer_list_dir",
      "desktop_input",
    ]);
  });
  test("exec defaults and truncation preserve nonzero exits", async () => {
    const received: unknown[] = [];
    const result = await call(
      port({
        exec: (input) => {
          received.push(input);
          return Promise.resolve({
            exitCode: 2,
            ok: true,
            stderr: "x".repeat(20_000),
            stdout: "é".repeat(TOOL_OUTPUT_MAX_BYTES),
          });
        },
      }),
      "computer_exec",
      { command: "ls" }
    );
    expect(received).toEqual([{ command: "ls", timeout_ms: 30_000 }]);
    expect(result.structuredContent).toMatchObject({ exitCode: 2 });
    expect(JSON.stringify(result.structuredContent)).toContain(
      "truncated: showing the first 16000"
    );
    expect(withTruncationNote(truncateText("aé", 2))).toBe(
      "a\n[truncated: showing the first 1 of 3 bytes]"
    );
  });
  test("normalises paths and refuses traversal, nulls and long paths", async () => {
    await Promise.all(
      ["relative", "/a/../b", "/./a", "/a\0b", `/${"x".repeat(1024)}`, ""].map(
        async (path) => {
          expect(validatePath(path).ok).toBe(false);
          expect(
            (await call(port(), "computer_read_file", { path })).isError
          ).toBe(true);
        }
      )
    );
    const received: unknown[] = [];
    await call(
      port({
        listDir: (input) => {
          received.push(input);
          return Promise.resolve({ entries: [], ok: true });
        },
      }),
      "computer_list_dir",
      { path: "//notes///" }
    );
    expect(received).toEqual([{ path: "/notes" }]);
  });
  test("edits exactly one match and validates resulting byte size before writing", async () => {
    const writes: unknown[] = [];
    const computer = port({
      writeFile: (input) => {
        writes.push(input);
        return Promise.resolve({
          created: false,
          ok: true,
          size: input.content.length,
        });
      },
    });
    expect(
      (
        await call(computer, "computer_edit_file", {
          new_string: "three",
          old_string: "one",
          path: "/a",
        })
      ).isError
    ).toBeFalsy();
    expect(writes).toEqual([{ content: "three two", path: "/a" }]);
    await Promise.all(
      ["", "missing", "o"].map(async (old_string) => {
        expect(
          (
            await call(computer, "computer_edit_file", {
              new_string: "x",
              old_string,
              path: "/a",
            })
          ).isError
        ).toBe(true);
      })
    );
    expect(
      (
        await call(computer, "computer_edit_file", {
          new_string: "é".repeat(MAX_FILE_BYTES / 2),
          old_string: "one",
          path: "/a",
        })
      ).isError
    ).toBe(true);
    expect(writes).toHaveLength(1);
  });
  test("bounds commands, timeout, files and desktop action batches", async () => {
    await Promise.all(
      [
        { command: "" },
        { command: "x".repeat(4001) },
        { command: "ls", timeout_ms: 600_001 },
        { command: "ls", timeout_ms: 0 },
      ].map(async (input) => {
        expect((await call(port(), "computer_exec", input)).isError).toBe(true);
      })
    );
    expect(
      (
        await call(port(), "computer_write_file", {
          content: "é".repeat(MAX_FILE_BYTES),
          path: "/a",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call(
          port({
            readFile: async () => ({
              content: "x".repeat(MAX_READ_BYTES + 1),
              ok: true,
              size: MAX_READ_BYTES + 1,
            }),
          }),
          "computer_read_file",
          { path: "/a" }
        )
      ).isError
    ).toBe(true);
    await Promise.all(
      [
        [],
        Array.from({ length: DESKTOP_MAX_ACTIONS + 1 }, () => ({
          keys: "a",
          type: "key",
        })),
        [{ type: "mouse_move", x: 1280, y: 0 }],
        [{ keys: "a;ls", type: "key" }],
        [{ text: "a".repeat(513), type: "type" }],
        [{ dx: 50, dy: 50, type: "scroll", x: 0, y: 0 }],
      ].map(async (actions) => {
        expect((await call(port(), "desktop_input", { actions })).isError).toBe(
          true
        );
      })
    );
    expect(
      (
        await call(port(), "desktop_input", {
          actions: [{ keys: "ctrl+l", type: "key" }],
        })
      ).isError
    ).toBeFalsy();
  });
  test("every typed failure becomes readable guidance", async () => {
    await Promise.all(
      (
        [
          "offline",
          "desktop_unavailable",
          "desktop_busy",
          "human_in_control",
          "timeout",
        ] as const
      ).map(async (code) => {
        const failure: PortFailure = { code, ok: false };
        await Promise.all(
          [
            "computer_exec",
            "computer_read_file",
            "computer_write_file",
            "computer_edit_file",
            "computer_list_dir",
            "desktop_input",
          ].map(async (name) => {
            const computer = port({
              desktopInput: async () => failure,
              exec: async () => failure,
              listDir: async () => failure,
              readFile: async () => failure,
              writeFile: async () => failure,
            });
            const inputs: Record<string, Record<string, unknown>> = {
              computer_edit_file: {
                new_string: "x",
                old_string: "one",
                path: "/a",
              },
              computer_exec: { command: "ls" },
              computer_list_dir: { path: "/a" },
              computer_read_file: { path: "/a" },
              computer_write_file: { content: "hi", path: "/a" },
              desktop_input: { actions: [{ keys: "a", type: "key" }] },
            };
            const args = inputs[name];
            const actual = await call(computer, name, args);
            expect(actual.isError).toBe(true);
            expect(JSON.stringify(actual.content)).toContain(code);
            expect(JSON.stringify(actual.content).length).toBeGreaterThan(70);
          })
        );
      })
    );
  });
});

test("computer file and desktop results preserve values and port inputs", async () => {
  const received: unknown[] = [];
  const computer = port({
    desktopInput: (input) => {
      received.push(input);
      return Promise.resolve({ ok: true });
    },
    writeFile: (input) => {
      received.push(input);
      return Promise.resolve({ created: true, ok: true, size: 2 });
    },
  });
  expect(
    (
      await call(computer, "computer_write_file", {
        content: "hi",
        path: "//a/",
      })
    ).structuredContent
  ).toEqual({ created: true, path: "/a", size: 2 });
  expect(
    (await call(computer, "computer_list_dir", { path: "/" })).structuredContent
  ).toEqual({
    entries: [{ directory: true, name: "notes", size: 0 }],
    path: "/",
  });
  const actions = [{ keys: "ctrl+l", type: "key" }];
  expect(
    (await call(computer, "desktop_input", { actions })).structuredContent
  ).toEqual({ applied: 1 });
  expect(received).toEqual([{ content: "hi", path: "/a" }, { actions }]);
  expect(
    computerTools({ computer }, { desktop: true })
      .filter((tool) => tool.annotations.readOnlyHint)
      .map((tool) => tool.name)
  ).toEqual(["computer_read_file", "computer_list_dir"]);
});

test("edit refuses an oversized source and reports a failed write", async () => {
  const writes: unknown[] = [];
  const computer = port({
    readFile: () =>
      Promise.resolve({ content: "one", ok: true, size: MAX_READ_BYTES + 1 }),
    writeFile: (input) => {
      writes.push(input);
      return Promise.resolve({ code: "offline", ok: false });
    },
  });
  const args = { new_string: "two", old_string: "one", path: "/a" };
  expect((await call(computer, "computer_edit_file", args)).isError).toBe(true);
  expect(writes).toEqual([]);
  const result = await call(
    port({ writeFile: computer.writeFile }),
    "computer_edit_file",
    args
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("offline");
});
