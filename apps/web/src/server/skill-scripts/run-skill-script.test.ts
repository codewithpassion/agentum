import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  PromptInput,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { loadSkills, type SkillsPort } from "../pi-run-skills.ts";
import {
  type ScriptLimits,
  SKILL_SCRIPTS_EXTENSION,
  skillScriptsExtension,
} from "./run-skill-script.ts";
import type {
  SandboxRunInput,
  SandboxRunResult,
  SkillScriptSandbox,
} from "./sandbox-port.ts";

// The script tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const NO_INPUT = {} as PromptInput;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const TOOL = "run_skill_script";
const SHOUT_MD =
  "---\nname: shout\ndescription: Shouts the answer.\n---\nAnswer in capitals.\n";
const SCRIPT_TEXT = "console.log(process.argv.slice(2).join(' '));";
const NOTE_TEXT = "A note bundled with the skill.";
const SKILL_FILES = {
  "shout/notes/a.md": NOTE_TEXT,
  "shout/SKILL.md": SHOUT_MD,
  "shout/scripts/hello.ts": SCRIPT_TEXT,
};
const OK: SandboxRunResult = { exitCode: 0, stderr: "", stdout: "" };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A port over a map of path to text. The map is read on every call. */
const portOver = (files: Record<string, string>): SkillsPort => ({
  list: () => Promise.resolve(Object.keys(files).map((path) => ({ path }))),
  read: (path) => {
    const text = files[path];
    if (text === undefined) {
      return Promise.reject(new Error(`no such file: ${path}`));
    }
    return Promise.resolve(encode(text));
  },
});

/** A sandbox that records each input and returns `result`. */
interface FakeSandbox extends SkillScriptSandbox {
  calls: SandboxRunInput[];
}

const fakeSandbox = (result: SandboxRunResult = OK): FakeSandbox => {
  const calls: SandboxRunInput[] = [];
  return {
    calls,
    run: (input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
};

const onlyCall = (sandbox: FakeSandbox): SandboxRunInput => {
  const [call, ...rest] = sandbox.calls;
  if (call === undefined || rest.length > 0) {
    throw new Error(`expected one sandbox call, got ${sandbox.calls.length}`);
  }
  return call;
};

const textOf = (result: ToolExecutionResult): string => {
  const content = result.output;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => ("text" in part ? part.text : "")).join("");
};

const toolNamed = (extension: Extension, name: string): ToolRegistration => {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return tool;
};

const execute = (
  extension: Extension,
  args: unknown
): Promise<ToolExecutionResult> =>
  toolNamed(extension, TOOL).execute(
    args,
    NO_API,
    CONTEXT
  ) as Promise<ToolExecutionResult>;

const LIMITS: ScriptLimits = {
  graceMs: 2000,
  maxOutputBytes: 64 * 1024,
  timeoutMs: 30_000,
};

/** The extension for `files`, with the skills loaded the way the platform loads them. */
const extensionFor = async (
  files: Record<string, string>,
  sandbox: SkillScriptSandbox,
  limits: ScriptLimits = LIMITS
): Promise<Extension> => {
  const port = portOver(files);
  return skillScriptsExtension(await loadSkills(port), port, sandbox, limits);
};

describe("skillScriptsExtension", () => {
  test("with no skills it adds no tools and no sections", () => {
    const extension = skillScriptsExtension([], portOver({}), fakeSandbox());
    expect(extension.name).toBe(SKILL_SCRIPTS_EXTENSION);
    expect(extension.tools ?? []).toEqual([]);
    expect(extension.sections ?? []).toEqual([]);
  });

  test("it adds the run tool, unsafe to replay, and a prompt section", async () => {
    const extension = await extensionFor(SKILL_FILES, fakeSandbox());
    expect(extension.name).toBe(SKILL_SCRIPTS_EXTENSION);
    expect(extension.tools?.map((tool) => tool.name)).toEqual([TOOL]);
    expect(toolNamed(extension, TOOL).replay).toBe("unsafe");
    const section = extension.sections?.[0];
    expect(section?.key).toBe("skill-scripts");
    expect(await section?.render(NO_INPUT, CONTEXT)).toBe(
      "Scripts written in TypeScript or JavaScript in a skill are run with run_skill_script, not read and imitated. The script sees only the skill's own files, has network access and no secrets, and runs for at most 30 seconds."
    );
  });

  test("the sandbox sees every skill file at its skill-relative path", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    await execute(extension, {
      args: ["a", "b"],
      path: "scripts/hello.ts",
      skill: "shout",
    });
    const call = onlyCall(sandbox);
    expect(call.entry).toBe("scripts/hello.ts");
    expect(call.args).toEqual(["a", "b"]);
    expect(call.maxOutputBytes).toBe(LIMITS.maxOutputBytes);
    expect(call.timeoutMs).toBe(LIMITS.timeoutMs);
    expect(
      Object.fromEntries(
        call.files.map((file) => [file.path, decode(file.bytes)])
      )
    ).toEqual({
      "notes/a.md": NOTE_TEXT,
      "SKILL.md": SHOUT_MD,
      "scripts/hello.ts": SCRIPT_TEXT,
    });
  });

  test("the sandbox is told the skill's name", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    expect(onlyCall(sandbox).skill).toBe("shout");
  });

  test("args default to none when the call leaves them out", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    expect(onlyCall(sandbox).args).toEqual([]);
  });

  test("a path with the <skill>/ prefix runs the same file", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    await execute(extension, {
      path: "shout/scripts/hello.ts",
      skill: "shout",
    });
    expect(onlyCall(sandbox).entry).toBe("scripts/hello.ts");
  });

  test("a path as given wins over the prefix when it is a file", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(
      { "shout/SKILL.md": SHOUT_MD, "shout/shout/x.ts": SCRIPT_TEXT },
      sandbox
    );
    await execute(extension, { path: "shout/x.ts", skill: "shout" });
    expect(onlyCall(sandbox).entry).toBe("shout/x.ts");
  });

  test("a run that never settles ends at the time cap with exit 124", async () => {
    const sandbox: SkillScriptSandbox = {
      run: () => new Promise<SandboxRunResult>(() => undefined),
    };
    const extension = await extensionFor(SKILL_FILES, sandbox, {
      graceMs: 20,
      maxOutputBytes: 1024,
      timeoutMs: 20,
    });
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "exit code: 124\n\nstderr:\ntimed out after 0.02 s"
    );
  });

  test("long stdout and stderr are cut and the message gives the totals", async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      stderr: "e".repeat(30),
      stdout: "o".repeat(100),
    });
    const extension = await extensionFor(SKILL_FILES, sandbox, {
      ...LIMITS,
      maxOutputBytes: 10,
    });
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      `exit code: 0\n\nstdout:\n${"o".repeat(10)}\n[truncated: showing the first 10 of 100 bytes]\n\nstderr:\n${"e".repeat(10)}\n[truncated: showing the first 10 of 30 bytes]`
    );
  });

  test("a cut never splits a multi-byte character", async () => {
    // Each "é" is two bytes, so 20 bytes in all. The cut at 5 falls inside the third one.
    const sandbox = fakeSandbox({
      exitCode: 0,
      stderr: "",
      stdout: "é".repeat(10),
    });
    const extension = await extensionFor(SKILL_FILES, sandbox, {
      ...LIMITS,
      maxOutputBytes: 5,
    });
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(textOf(result)).toBe(
      "exit code: 0\n\nstdout:\néé\n[truncated: showing the first 5 of 20 bytes]"
    );
  });

  test("a non-zero exit is an error result that shows stderr", async () => {
    const sandbox = fakeSandbox({ exitCode: 2, stderr: "boom", stdout: "" });
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("exit code: 2\n\nstderr:\nboom");
  });

  test("a run with no output says so", async () => {
    const sandbox = fakeSandbox(OK);
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("exit code: 0\n\n(no output)");
  });

  test("an unknown skill is an error and the sandbox is not called", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "nope",
    });
    expect(result.isError).toBe(true);
    expect(sandbox.calls).toEqual([]);
  });

  test("a path that is not a file of the skill is an error", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/missing.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("scripts/missing.ts");
    expect(sandbox.calls).toEqual([]);
  });

  test("a file that is not a script is an error", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "notes/a.md",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(sandbox.calls).toEqual([]);
  });

  test("a path with .. is an error even when it resolves to a file", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/../scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(sandbox.calls).toEqual([]);
  });

  test("an absolute path is an error", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "/scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(sandbox.calls).toEqual([]);
  });

  test("a sandbox rejection is an error result", async () => {
    const sandbox: SkillScriptSandbox = {
      run: () => Promise.reject(new Error("kaboom")),
    };
    const extension = await extensionFor(SKILL_FILES, sandbox);
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("The sandbox failed: kaboom");
  });
});
