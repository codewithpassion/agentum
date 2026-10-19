import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  PromptInput,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { loadSkills, type SkillsPort } from "../pi-run-skills.ts";
import { dynamicWorkerSandbox } from "./dynamic-worker-sandbox.ts";
import { localWorkerLoader } from "./local-worker-loader.ts";
import {
  ISOLATE_SCRIPT_TEXTS,
  type ScriptLimits,
  type ScriptSecrets,
  SKILL_SCRIPTS_EXTENSION,
  type SkillVersionFiles,
  skillScriptsExtension,
} from "./run-skill-script.ts";
import type {
  SandboxFile,
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
  limits: ScriptLimits = LIMITS,
  secrets?: ScriptSecrets
): Promise<Extension> => {
  const port = portOver(files);
  return skillScriptsExtension(
    await loadSkills(port),
    port,
    sandbox,
    secrets,
    limits
  );
};

const SECRET_VALUE = "fake-secret-value-123";
const GRANT_ENV = { FAKE_TOKEN: SECRET_VALUE };
/** A grant that masks the granted value the way the platform does. */
const grantedSecrets = (proxy = true): ScriptSecrets => ({
  forRun: () =>
    Promise.resolve({
      env: GRANT_ENV,
      mask: (text) => text.replaceAll(SECRET_VALUE, "[redacted]"),
      proxy,
    }),
});
const PLAIN_SENTENCE =
  "The script sees only the skill's own files, has network access and no secrets, and runs for at most 30 seconds.";
const GRANTED_SENTENCE =
  "The script sees only the skill's own files and has network access. It has no secrets of its own: the environment variables the agent was granted are set in process.env, and requests to hosts the agent has a credential for get that credential added for it. It runs for at most 30 seconds.";

describe("skillScriptsExtension", () => {
  test("with no skills it adds no tools and no sections", () => {
    const extension = skillScriptsExtension(
      [],
      portOver({}),
      fakeSandbox(),
      undefined
    );
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

  test("with no secrets the input has no env and the prompt is the old sentence", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox);
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    const call = onlyCall(sandbox);
    expect(call.env).toBeUndefined();
    expect(call.proxy).toBeUndefined();
    expect(await extension.sections?.[0]?.render(NO_INPUT, CONTEXT)).toContain(
      PLAIN_SENTENCE
    );
  });

  test("with secrets the prompt names the granted environment and the proxy", async () => {
    const extension = await extensionFor(
      SKILL_FILES,
      fakeSandbox(),
      LIMITS,
      grantedSecrets()
    );
    expect(await extension.sections?.[0]?.render(NO_INPUT, CONTEXT)).toContain(
      GRANTED_SENTENCE
    );
  });

  test("granted env and proxy reach the sandbox run", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(
      SKILL_FILES,
      sandbox,
      LIMITS,
      grantedSecrets(true)
    );
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    const call = onlyCall(sandbox);
    expect(call.env).toEqual(GRANT_ENV);
    expect(call.proxy).toBe(true);
  });

  test("a grant with proxy off passes proxy false", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(
      SKILL_FILES,
      sandbox,
      LIMITS,
      grantedSecrets(false)
    );
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    expect(onlyCall(sandbox).proxy).toBe(false);
  });

  test("a granted value printed to stdout and stderr is masked in the answer", async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      stderr: `warn ${SECRET_VALUE}`,
      stdout: `token is ${SECRET_VALUE}`,
    });
    const extension = await extensionFor(
      SKILL_FILES,
      sandbox,
      LIMITS,
      grantedSecrets()
    );
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(textOf(result)).toBe(
      "exit code: 0\n\nstdout:\ntoken is [redacted]\n\nstderr:\nwarn [redacted]"
    );
    expect(textOf(result)).not.toContain(SECRET_VALUE);
  });

  test("a value split by the output cap is still masked, because masking runs first", async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      stderr: "",
      stdout: `${"x".repeat(4)}${SECRET_VALUE}`,
    });
    const extension = await extensionFor(
      SKILL_FILES,
      sandbox,
      { ...LIMITS, maxOutputBytes: 10 },
      grantedSecrets()
    );
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    // Cap-then-mask would keep "fake-s" of the value, which no mask finds.
    expect(textOf(result)).not.toContain("fake-");
    expect(textOf(result)).toContain("xxxx[redac");
  });

  test("a failing forRun is an error result and the sandbox is not called", async () => {
    const sandbox = fakeSandbox();
    const extension = await extensionFor(SKILL_FILES, sandbox, LIMITS, {
      forRun: () => Promise.reject(new Error("vault is down")),
    });
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Could not read the secrets: vault is down");
    expect(sandbox.calls).toEqual([]);
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

const PROPOSED_SCRIPT = "console.log('proposed');";
const PROPOSED_FILES: SandboxFile[] = [
  { bytes: encode(SHOUT_MD), path: "SKILL.md" },
  { bytes: encode(PROPOSED_SCRIPT), path: "scripts/hello.ts" },
];

/** A version reader that returns `files`, or rejects with `failure`, and records each call. */
const versionReader = (
  files: SandboxFile[],
  failure?: Error
): { calls: [string, number][]; read: SkillVersionFiles } => {
  const calls: [string, number][] = [];
  return {
    calls,
    read: (skill, version) => {
      calls.push([skill, version]);
      return failure === undefined
        ? Promise.resolve(files)
        : Promise.reject(failure);
    },
  };
};

const extensionWithVersions = (
  files: Record<string, string>,
  sandbox: SkillScriptSandbox,
  versions: SkillVersionFiles
): Promise<Extension> => {
  const port = portOver(files);
  return loadSkills(port).then((skills) =>
    skillScriptsExtension(
      skills,
      port,
      sandbox,
      undefined,
      LIMITS,
      ISOLATE_SCRIPT_TEXTS,
      versions
    )
  );
};

describe("skillScriptsExtension in the local Dynamic Worker loader", () => {
  let helper: ReturnType<typeof localWorkerLoader>;

  beforeEach(() => {
    helper = localWorkerLoader();
  });

  afterEach(() => {
    helper.restore();
  });

  test("a run that never settles keeps the output it printed", async () => {
    const extension = await extensionFor(
      {
        ...SKILL_FILES,
        "shout/scripts/hang.ts": [
          'console.log("one");',
          'console.log("two");',
          'console.error("three");',
          "for (;;) { await new Promise((resolve) => setTimeout(resolve, 10)); }",
          "",
        ].join("\n"),
      },
      dynamicWorkerSandbox(helper.loader),
      { graceMs: 1000, maxOutputBytes: 65_536, timeoutMs: 100 }
    );
    const result = await execute(extension, {
      path: "scripts/hang.ts",
      skill: "shout",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "exit code: 124\n\nstdout:\none\ntwo\n\n\nstderr:\nthree\ntimed out after 0.1 s\n"
    );
  });
});

describe("skillScriptsExtension with versions", () => {
  test("a call with version runs the files the callback returned, not the port's", async () => {
    const sandbox = fakeSandbox();
    const reader = versionReader(PROPOSED_FILES);
    const extension = await extensionWithVersions(
      SKILL_FILES,
      sandbox,
      reader.read
    );
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
      version: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(reader.calls).toEqual([["shout", 2]]);
    const call = onlyCall(sandbox);
    expect(call.skill).toBe("shout");
    expect(call.entry).toBe("scripts/hello.ts");
    expect(
      Object.fromEntries(
        call.files.map((file) => [file.path, decode(file.bytes)])
      )
    ).toEqual({
      "SKILL.md": SHOUT_MD,
      "scripts/hello.ts": PROPOSED_SCRIPT,
    });
  });

  test("a skill not in the catalog runs with a version", async () => {
    const sandbox = fakeSandbox();
    const reader = versionReader(PROPOSED_FILES);
    const extension = await extensionWithVersions({}, sandbox, reader.read);
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
      version: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(onlyCall(sandbox).skill).toBe("shout");
  });

  test("a rejecting callback is an error result and the sandbox is not called", async () => {
    const sandbox = fakeSandbox();
    const reader = versionReader([], new Error("no such version"));
    const extension = await extensionWithVersions(
      SKILL_FILES,
      sandbox,
      reader.read
    );
    const result = await execute(extension, {
      path: "scripts/hello.ts",
      skill: "shout",
      version: 3,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Could not read version 3 of shout: no such version"
    );
    expect(sandbox.calls).toEqual([]);
  });

  test("a path with .. or a non-script path is refused with a version too", async () => {
    const sandbox = fakeSandbox();
    const reader = versionReader(PROPOSED_FILES);
    const extension = await extensionWithVersions(
      SKILL_FILES,
      sandbox,
      reader.read
    );
    const escaping = await execute(extension, {
      path: "scripts/../scripts/hello.ts",
      skill: "shout",
      version: 2,
    });
    const notScript = await execute(extension, {
      path: "SKILL.md",
      skill: "shout",
      version: 2,
    });
    expect(escaping.isError).toBe(true);
    expect(notScript.isError).toBe(true);
    expect(sandbox.calls).toEqual([]);
  });

  test("a call without version still uses the catalog and the port", async () => {
    const sandbox = fakeSandbox();
    const reader = versionReader(PROPOSED_FILES);
    const extension = await extensionWithVersions(
      SKILL_FILES,
      sandbox,
      reader.read
    );
    await execute(extension, { path: "scripts/hello.ts", skill: "shout" });
    const call = onlyCall(sandbox);
    expect(reader.calls).toEqual([]);
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

  test("without versions the tool has no version parameter", async () => {
    const extension = await extensionFor(SKILL_FILES, fakeSandbox());
    const schema = toolNamed(extension, TOOL).parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).not.toContain("version");
  });

  test("with versions the tool takes an optional integer version and any skill name", async () => {
    const extension = await extensionWithVersions(
      SKILL_FILES,
      fakeSandbox(),
      versionReader(PROPOSED_FILES).read
    );
    const schema = toolNamed(extension, TOOL).parameters as {
      properties: Record<string, { type?: string; minimum?: number }>;
      required?: string[];
    };
    expect(schema.properties).toMatchObject({
      skill: { type: "string" },
      version: { minimum: 1, type: "integer" },
    });
    expect(schema.required ?? []).not.toContain("version");
  });

  test("with versions and no skills the extension still has the tool", () => {
    const extension = skillScriptsExtension(
      [],
      portOver({}),
      fakeSandbox(),
      undefined,
      LIMITS,
      ISOLATE_SCRIPT_TEXTS,
      versionReader(PROPOSED_FILES).read
    );
    expect(extension.tools?.map((tool) => tool.name)).toEqual([TOOL]);
  });
});
