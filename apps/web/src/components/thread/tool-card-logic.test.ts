import { expect, test } from "bun:test";
import {
  asText,
  groupLabel,
  type ToolCall,
  toolCardInfo,
} from "./tool-card-logic.ts";

const call = (overrides: Partial<ToolCall>): ToolCall => ({
  input: null,
  name: "bash",
  ok: true,
  result: null,
  ...overrides,
});

test("bash-like names are command tools, whatever their case", () => {
  for (const name of [
    "bash",
    "shell",
    "sh",
    "exec",
    "run_command",
    "execute_command",
    "Bash",
    "RUN_COMMAND",
  ]) {
    expect(toolCardInfo(call({ name })).kind).toBe("command");
  }
});

test("file tools are file tools", () => {
  for (const name of [
    "read",
    "write",
    "edit",
    "multiedit",
    "view",
    "str_replace_editor",
    "read_file",
    "write_file",
    "edit_file",
    "Edit",
  ]) {
    expect(toolCardInfo(call({ name })).kind).toBe("file");
  }
});

test("web tools are web tools", () => {
  for (const name of [
    "webfetch",
    "websearch",
    "web_fetch",
    "web_search",
    "fetch",
    "WebSearch",
  ]) {
    expect(toolCardInfo(call({ name })).kind).toBe("web");
  }
});

test("skill tools are skill tools", () => {
  for (const name of ["skill", "activate_skill", "Skill"]) {
    expect(toolCardInfo(call({ name })).kind).toBe("skill");
  }
});

test("any other name, or no name, is a generic tool", () => {
  expect(toolCardInfo(call({ name: "mcp__x__y" })).kind).toBe("generic");
  expect(toolCardInfo(call({ name: "bashful" })).kind).toBe("generic");
  expect(toolCardInfo(call({ name: null })).kind).toBe("generic");
});

test("the title is the tool name, or Tool when there is none", () => {
  expect(toolCardInfo(call({ name: "bash" })).title).toBe("bash");
  expect(toolCardInfo(call({ name: null })).title).toBe("Tool");
});

test("a command's subtitle is its command, or its cmd field", () => {
  expect(toolCardInfo(call({ input: { command: "ls -la" } })).subtitle).toBe(
    "ls -la"
  );
  expect(toolCardInfo(call({ input: { cmd: "pwd" } })).subtitle).toBe("pwd");
});

test("a subtitle uses the second field when the first is empty", () => {
  const info = toolCardInfo(
    call({ input: { cmd: "pwd", command: "" }, name: "bash" })
  );
  expect(info.subtitle).toBe("pwd");
});

test("a file's subtitle is its path, from the first field it has", () => {
  const file = (input: unknown) =>
    toolCardInfo(call({ input, name: "read" })).subtitle;
  expect(file({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
  expect(file({ path: "/c.ts" })).toBe("/c.ts");
  expect(file({ filename: "d.ts" })).toBe("d.ts");
  expect(file({ file_path: "", path: "/e.ts" })).toBe("/e.ts");
});

test("a web tool's subtitle is its url, else its query", () => {
  expect(
    toolCardInfo(call({ input: { url: "https://x.test" }, name: "fetch" }))
      .subtitle
  ).toBe("https://x.test");
  expect(
    toolCardInfo(call({ input: { query: "cats" }, name: "websearch" })).subtitle
  ).toBe("cats");
});

test("a skill's subtitle is its skill name, else its name", () => {
  expect(
    toolCardInfo(call({ input: { skill: "pdf" }, name: "skill" })).subtitle
  ).toBe("pdf");
  expect(
    toolCardInfo(call({ input: { name: "docx" }, name: "activate_skill" }))
      .subtitle
  ).toBe("docx");
});

test("a generic tool has no subtitle, even with a command-like field", () => {
  expect(
    toolCardInfo(call({ input: { command: "ls" }, name: "mcp__x" })).subtitle
  ).toBeNull();
});

test("input that is not a plain object gives no subtitle", () => {
  expect(toolCardInfo(call({ input: ["ls"], name: "bash" })).subtitle).toBe(
    null
  );
  expect(toolCardInfo(call({ input: "ls", name: "bash" })).subtitle).toBeNull();
  expect(toolCardInfo(call({ input: null, name: "bash" })).subtitle).toBeNull();
});

test("a field that is missing or not a string gives no subtitle", () => {
  expect(toolCardInfo(call({ input: { command: 5 } })).subtitle).toBeNull();
  expect(toolCardInfo(call({ input: {} })).subtitle).toBeNull();
});

test("a subtitle at exactly 120 characters is kept whole", () => {
  const text = "a".repeat(120);
  expect(toolCardInfo(call({ input: { command: text } })).subtitle).toBe(text);
});

test("a subtitle one character over 120 is cut to 120, ending in an ellipsis", () => {
  const { subtitle } = toolCardInfo(
    call({ input: { command: "a".repeat(121) } })
  );
  expect(subtitle).toBe(`${"a".repeat(119)}…`);
  expect(subtitle?.length).toBe(120);
});

test("the state follows ok: null is running, true done, false failed", () => {
  expect(toolCardInfo(call({ ok: null })).state).toBe("running");
  expect(toolCardInfo(call({ ok: true })).state).toBe("done");
  expect(toolCardInfo(call({ ok: false })).state).toBe("failed");
});

test("the output is the result as text", () => {
  expect(toolCardInfo(call({ result: "hello" })).output).toBe("hello");
  expect(toolCardInfo(call({ result: null })).output).toBeNull();
  expect(toolCardInfo(call({ result: "" })).output).toBeNull();
});

test("the input is the input as pretty JSON for the details view", () => {
  expect(toolCardInfo(call({ input: { command: "ls" } })).input).toBe(
    '{\n  "command": "ls"\n}'
  );
  expect(toolCardInfo(call({ input: null })).input).toBeNull();
});

test("an output at exactly 4000 characters is kept whole", () => {
  const text = "x".repeat(4000);
  expect(toolCardInfo(call({ result: text })).output).toBe(text);
});

test("an output one character over 4000 is cut and marked as truncated", () => {
  expect(toolCardInfo(call({ result: "x".repeat(4001) })).output).toBe(
    `${"x".repeat(4000)}\n… (truncated)`
  );
});

test("an input over the limit is cut and marked as truncated", () => {
  const info = toolCardInfo(call({ input: "y".repeat(4001) }));
  expect(info.input).toBe(`${"y".repeat(4000)}\n… (truncated)`);
});

test("a subtitle cut inside a surrogate pair keeps whole characters", () => {
  const emoji = "😀";
  const { subtitle } = toolCardInfo(
    call({ input: { command: emoji.repeat(121) } })
  );
  expect(subtitle).toBe(`${emoji.repeat(119)}…`);
});

test("asText keeps a string as it is", () => {
  expect(asText("plain text")).toBe("plain text");
});

test("asText writes a number as JSON", () => {
  expect(asText(42)).toBe("42");
});

test("asText pretty prints an object as JSON", () => {
  expect(asText({ a: 1 })).toBe('{\n  "a": 1\n}');
});

test("asText gives null for null, undefined and the empty string", () => {
  expect(asText(null)).toBeNull();
  expect(asText(undefined)).toBeNull();
  expect(asText("")).toBeNull();
});

test("asText falls back to String when JSON cannot encode the value", () => {
  expect(asText(10n)).toBe("10");
});

test("the state label of a call is the state of its ok flag", () => {
  expect(toolCardInfo(call({ ok: null, result: "" })).state).toBe("running");
});

test("a group of one name reads as that name", () => {
  expect(groupLabel(["bash"])).toBe("bash");
});

test("a single unnamed call reads as Tool", () => {
  expect(groupLabel([null])).toBe("Tool");
});

test("a group of the same name counts its calls", () => {
  expect(groupLabel(["bash", "bash", "bash"])).toBe("bash ×3");
});

test("a group of different names lists each run of the same name", () => {
  expect(groupLabel(["bash", "read"])).toBe("bash, read");
  expect(groupLabel(["Read", "Read", "Read", "Bash"])).toBe("Read ×3, Bash");
  expect(groupLabel(["a", "b", "b", "a"])).toBe("a, b ×2, a");
});

test("unnamed calls read as Tool", () => {
  expect(groupLabel([null, null])).toBe("Tool ×2");
  expect(groupLabel(["bash", null])).toBe("bash, Tool");
});

test("an empty group reads as no tool calls", () => {
  expect(groupLabel([])).toBe("No tool calls");
});
