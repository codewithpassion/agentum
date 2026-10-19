import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { LibraryEntry } from "@repo/services/library";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import { dynamicWorkerSandbox } from "./dynamic-worker-sandbox.ts";
import { localWorkerLoader } from "./local-worker-loader.ts";
import {
  RUN_SCRIPT_EXTENSION,
  type RunScriptDeps,
  runScriptExtension,
  type ScriptRunEntry,
} from "./run-script.ts";
import type { ScriptLimits } from "./run-skill-script.ts";
import type { SkillScriptSandbox } from "./sandbox-port.ts";
import { createScriptHost } from "./script-host-core.ts";

// The script tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const TOOL = "run_script";
const DURATION_LINE = /duration: \d+ ms/;
const HOME = "agents/robo";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const entryOf = (path: string, kind: "dir" | "file"): LibraryEntry => ({
  etag: null,
  kind,
  mtime: "2026-10-19T00:00:00.000Z",
  path,
  size: 0,
  updatedBy: { id: "agent-1", kind: "agent" },
});

/** An in-memory library. Reads of a missing file reject, as the service does. */
const libraryOver = (initial: Record<string, string>) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, encoder.encode(text)])
  );
  const ops: Pick<LibraryOps, "list" | "read" | "write"> = {
    list: (dir) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Map<string, "dir" | "file">();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          names.set(
            slash === -1 ? rest : rest.slice(0, slash),
            slash === -1 ? "file" : "dir"
          );
        }
      }
      return Promise.resolve(
        [...names].map(([name, kind]) => entryOf(`${prefix}${name}`, kind))
      );
    },
    read: (path) => {
      const bytes = files.get(path);
      return bytes === undefined
        ? Promise.reject(new Error(`no such file: ${path}`))
        : Promise.resolve({ bytes, entry: entryOf(path, "file") });
    },
    write: (path, bytes) => {
      files.set(path, bytes);
      return Promise.resolve(entryOf(path, "file"));
    },
  };
  return { files, ops };
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

describe("runScriptExtension", () => {
  let helper: ReturnType<typeof localWorkerLoader>;

  beforeEach(() => {
    helper = localWorkerLoader();
  });

  afterEach(() => {
    helper.restore();
  });

  /** The extension over an in-memory library at HOME, run in the local Dynamic Worker loader. */
  const setup = (
    initial: Record<string, string> = {},
    options: {
      limits?: ScriptLimits;
      record?: (entry: ScriptRunEntry) => Promise<void>;
      sandboxOf?: () => Promise<SkillScriptSandbox>;
    } = {}
  ) => {
    const library = libraryOver(initial);
    const records: ScriptRunEntry[] = [];
    const deps: RunScriptDeps = {
      homeOf: () => Promise.resolve(HOME),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      read: (path) => Promise.resolve(library.files.get(path) ?? null),
      record:
        options.record ??
        ((entry) => {
          records.push(entry);
          return Promise.resolve();
        }),
      sandboxOf:
        options.sandboxOf ??
        (() =>
          Promise.resolve(
            dynamicWorkerSandbox(helper.loader, undefined, () =>
              createScriptHost({
                fetcher: undefined,
                home: HOME,
                ops: library.ops,
              })
            )
          )),
    };
    return {
      extension: runScriptExtension(deps),
      files: library.files,
      records,
    };
  };

  test("a TypeScript file with a type annotation prints its output", async () => {
    const { extension } = setup({
      "agents/robo/hello.ts":
        'const who: string = "harbour";\nconsole.log("hi " + who);\n',
    });
    const result = await execute(extension, { path: "hello.ts" });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("exit code: 0");
    expect(text).toMatch(DURATION_LINE);
    expect(text).toContain("stdout:\nhi harbour\n");
  });

  test("inline JavaScript and inline TypeScript both run", async () => {
    const { extension } = setup();
    const js = await execute(extension, {
      code: 'console.log("js", 1 + 1);',
      language: "js",
    });
    const ts = await execute(extension, {
      code: 'const n: number = 3;\nconsole.log("ts", n);',
      language: "ts",
    });

    expect(textOf(js)).toContain("stdout:\njs 2\n");
    expect(textOf(ts)).toContain("stdout:\nts 3\n");
  });

  test("relative imports work in the same folder and with ../", async () => {
    const { extension } = setup({
      "agents/robo/lib/say.ts":
        'import { wrap } from "../wrap.ts";\nexport const say = (n: number): string => wrap(String(n));\n',
      "agents/robo/main.ts": [
        'import { double } from "./math.ts";',
        'import { say } from "./lib/say.ts";',
        "console.log(say(double(21)));",
        "",
      ].join("\n"),
      "agents/robo/math.ts":
        'import { ONE } from "./unit.ts";\nexport const double = (n: number): number => n * 2 * ONE;\n',
      "agents/robo/unit.ts": "export const ONE = 1;\n",
      "agents/robo/wrap.ts":
        'export const wrap = (s: string): string => "<" + s + ">";\n',
    });
    const result = await execute(extension, { path: "main.ts" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("stdout:\n<42>\n");
  });

  test("a thrown error is exit code 1 with the message on stderr", async () => {
    const { extension } = setup();
    const result = await execute(extension, {
      code: 'throw new Error("boom here");',
      language: "js",
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("exit code: 1");
    expect(text).toContain("stderr:\n");
    expect(text).toContain("boom here");
  });

  test("process.exit sets the exit code", async () => {
    const { extension } = setup();
    const result = await execute(extension, {
      code: 'console.log("bye");\nprocess.exit(5);',
      language: "js",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exit code: 5");
  });

  test("a script that never settles ends with exit code 124", async () => {
    const { extension } = setup(
      {},
      {
        limits: { graceMs: 100, maxOutputBytes: 65_536, timeoutMs: 100 },
      }
    );
    const result = await execute(extension, {
      code: "await new Promise(() => {});",
      language: "js",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exit code: 124");
  });

  test("args reach process.argv and stdin reaches the global", async () => {
    const { extension } = setup();
    const result = await execute(extension, {
      args: ["one", "two"],
      code: "console.log(process.argv.slice(2).join('|'));\nconsole.log(stdin.toUpperCase());",
      language: "js",
      stdin: "typed text",
    });

    expect(textOf(result)).toContain("stdout:\none|two\nTYPED TEXT\n");
  });

  test("library.write stores a file in the home folder and library.read reads one", async () => {
    const { extension, files } = setup({
      "agents/robo/notes.txt": "old note",
    });
    const result = await execute(extension, {
      code: [
        'await library.write("out.txt", "hi");',
        'console.log(await library.read("notes.txt"));',
        "",
      ].join("\n"),
      language: "js",
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("stdout:\nold note\n");
    expect(decoder.decode(files.get("agents/robo/out.txt"))).toBe("hi");
  });

  test("bad arguments are errors and no script runs", async () => {
    const { extension } = setup({
      "agents/robo/notes.md": "# notes",
    });
    const neither = await execute(extension, {});
    const both = await execute(extension, {
      code: "console.log(1);",
      language: "js",
      path: "hello.ts",
    });
    const noLanguage = await execute(extension, {
      code: "console.log(1);",
    });
    const markdown = await execute(extension, { path: "notes.md" });
    const missing = await execute(extension, { path: "missing.ts" });
    const outside = await execute(extension, { path: "/etc/passwd" });

    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toBe(
      "Give either path or code, not both and not neither."
    );
    expect(textOf(both)).toBe(
      "Give either path or code, not both and not neither."
    );
    expect(textOf(noLanguage)).toBe(
      "language (ts or js) is required with code."
    );
    expect(textOf(markdown)).toBe(
      "Not a script (.ts, .mts, .js, .mjs): notes.md"
    );
    expect(textOf(missing)).toBe("Not a file in the library: missing.ts");
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("Path is outside /library");
    expect(helper.configs).toHaveLength(0);
  });

  test("the log gets the library path and sizes, and no code or output", async () => {
    const { extension, records } = setup({
      "agents/robo/hello.ts": 'console.log("SECRET-OUT-TEXT");\n',
    });
    await execute(extension, { path: "hello.ts" });

    expect(records).toHaveLength(1);
    const [entry] = records;
    expect(entry?.script).toBe("agents/robo/hello.ts");
    expect(entry?.exitCode).toBe(0);
    expect(typeof entry?.durationMs).toBe("number");
    expect(entry?.stdoutBytes).toBe(
      encoder.encode("SECRET-OUT-TEXT\n").byteLength
    );
    expect(entry?.stderrBytes).toBe(0);
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "durationMs",
      "exitCode",
      "script",
      "stderrBytes",
      "stdoutBytes",
    ]);
    expect(JSON.stringify(entry)).not.toContain("SECRET-OUT-TEXT");
  });

  test("an inline run logs as inline with its stderr size and no code", async () => {
    const { extension, records } = setup();
    await execute(extension, {
      code: 'console.error("ERR-TEXT");\nconsole.log("CODE-MARKER-7731".length);',
      language: "js",
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.script).toBe("inline");
    expect(records[0]?.stderrBytes).toBe(
      encoder.encode("ERR-TEXT\n").byteLength
    );
    const logged = JSON.stringify(records[0]);
    expect(logged).not.toContain("CODE-MARKER");
    expect(logged).not.toContain("ERR-TEXT");
  });

  test("a rejecting record does not change the result", async () => {
    const { extension } = setup(
      { "agents/robo/hello.ts": 'console.log("still here");\n' },
      { record: () => Promise.reject(new Error("log is down")) }
    );
    const result = await execute(extension, { path: "hello.ts" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("exit code: 0");
    expect(textOf(result)).toContain("stdout:\nstill here\n");
  });

  test("output over the cap is cut with the truncated note", async () => {
    const { extension } = setup(
      {},
      {
        limits: { graceMs: 2000, maxOutputBytes: 100, timeoutMs: 5000 },
      }
    );
    const result = await execute(extension, {
      code: 'console.log("x".repeat(500));',
      language: "js",
    });

    expect(textOf(result)).toContain(
      "[truncated: showing the first 100 of 501 bytes]"
    );
  });

  test("a rejecting sandbox is an error result and nothing is recorded", async () => {
    const { extension, records } = setup(
      {},
      {
        sandboxOf: () =>
          Promise.resolve({
            run: () => Promise.reject(new Error("kaboom")),
          }),
      }
    );
    const result = await execute(extension, {
      code: 'console.log("unused");',
      language: "js",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("The sandbox failed: kaboom");
    expect(records).toEqual([]);
  });

  test("the description names what is not available and the network rule", () => {
    const { extension } = setup();
    const { description } = toolNamed(extension, TOOL);

    expect(extension.name).toBe(RUN_SCRIPT_EXTENSION);
    expect(description).toContain("npm packages");
    expect(description).toContain("Network access is off for this agent.");
  });
});
