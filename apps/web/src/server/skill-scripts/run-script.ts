import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { clamp } from "../library-bash/library-fs.ts";
import { libraryPathOf } from "./library-path.ts";
import {
  capOutput,
  errorText,
  runWithSafetyNet,
  SCRIPT_LIMITS,
  type ScriptLimits,
  textResult,
} from "./run-skill-script.ts";
import type {
  SandboxFile,
  SandboxRunResult,
  SkillScriptSandbox,
} from "./sandbox-port.ts";

export const RUN_SCRIPT_EXTENSION = "hm-run-script";

const TOOL_NAME = "run_script";
const SCRIPT_PATTERN = /\.(?:ts|mts|js|mjs)$/;
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const MAX_FILES = 100;
const BOTH_OR_NEITHER = "Give either path or code, not both and not neither.";
const INLINE_SCRIPT = "inline";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the Log keeps of one run. No code, args, stdin or output. */
export interface ScriptRunEntry {
  durationMs: number;
  exitCode: number;
  script: string;
  stderrBytes: number;
  stdoutBytes: number;
}

export interface RunScriptDeps {
  /** The agent's library home such as "agents/robo", or "" for the root. Read when a call comes. */
  homeOf: () => Promise<string>;
  limits?: ScriptLimits;
  /** Reads a library file by library path (no leading slash). null when it does not exist. */
  read: (path: string) => Promise<Uint8Array | null>;
  /** Writes the script.run event. May reject: the result still goes back. */
  record: (entry: ScriptRunEntry) => Promise<void>;
  /** The sandbox for this call. */
  sandboxOf: () => Promise<SkillScriptSandbox>;
}

/** The script to run: its entry file, and the log name of it. */
interface Source {
  entry: SandboxFile;
  script: string;
}

type Request =
  | { kind: "library"; path: string }
  | { code: string; kind: "inline"; language: "js" | "ts" };

const problem = (message: string): { problem: string } => ({
  problem: message,
});

/** The request the arguments make, or the problem with them. */
const requestOf = ({
  code,
  language,
  path,
}: {
  code?: string;
  language?: "js" | "ts";
  path?: string;
}): Request | { problem: string } => {
  if (path !== undefined) {
    return code === undefined
      ? { kind: "library", path }
      : problem(BOTH_OR_NEITHER);
  }
  if (code === undefined) {
    return problem(BOTH_OR_NEITHER);
  }
  if (language === undefined) {
    return problem("language (ts or js) is required with code.");
  }
  return { code, kind: "inline", language };
};

/** The library file at `path`, read as the entry script. */
const libraryScript = async (
  read: RunScriptDeps["read"],
  home: string,
  path: string
): Promise<Source | { problem: string }> => {
  let script: string;
  try {
    script = libraryPathOf(home, path);
  } catch (error) {
    return problem(errorText(error));
  }
  if (!SCRIPT_PATTERN.test(script)) {
    return problem(`Not a script (.ts, .mts, .js, .mjs): ${path}`);
  }
  const bytes = await read(script);
  if (bytes === null) {
    return problem(`Not a file in the library: ${path}`);
  }
  return { entry: { bytes, path: script }, script };
};

/** Inline code as a virtual file in the home folder, so its relative imports resolve there. */
const inlineScript = (
  home: string,
  code: string,
  language: "js" | "ts"
): Source => {
  const name = `__inline__.${language}`;
  return {
    entry: {
      bytes: encoder.encode(code),
      path: home === "" ? name : `${home}/${name}`,
    },
    script: INLINE_SCRIPT,
  };
};

/** The relative imports of a script, as library paths. */
const importsOf = (file: SandboxFile): string[] => {
  const folder = file.path.slice(0, Math.max(file.path.lastIndexOf("/"), 0));
  return [...decoder.decode(file.bytes).matchAll(IMPORT_PATTERN)].flatMap(
    ([, spec]) =>
      spec === undefined ? [] : [clamp(`/${folder}/${spec}`).slice(1)]
  );
};

/** Reads the imports of `layer` not tried yet, then the imports of the scripts found, and so on. */
const collectFrom = async (
  read: RunScriptDeps["read"],
  layer: SandboxFile[],
  files: Map<string, Uint8Array>,
  tried: Set<string>
): Promise<SandboxFile[] | { problem: string }> => {
  const wanted = [...new Set(layer.flatMap(importsOf))].filter(
    (path) => !tried.has(path)
  );
  for (const path of wanted) {
    tried.add(path);
  }
  const found = await Promise.all(
    wanted.map(async (path) => ({ bytes: await read(path), path }))
  );
  const next: SandboxFile[] = [];
  for (const { bytes, path } of found) {
    if (bytes === null) {
      continue;
    }
    if (files.size >= MAX_FILES) {
      return problem(`The script imports more than ${MAX_FILES} files.`);
    }
    files.set(path, bytes);
    if (SCRIPT_PATTERN.test(path)) {
      next.push({ bytes, path });
    }
  }
  if (next.length === 0) {
    return [...files].map(([path, bytes]) => ({ bytes, path }));
  }
  return collectFrom(read, next, files, tried);
};

/** The entry and every file it reaches by relative import, or the problem with the set. */
const collectFiles = (
  read: RunScriptDeps["read"],
  entry: SandboxFile
): Promise<SandboxFile[] | { problem: string }> =>
  collectFrom(
    read,
    [entry],
    new Map([[entry.path, entry.bytes]]),
    new Set([entry.path])
  );

const describeRun = (
  result: SandboxRunResult,
  durationMs: number,
  maxOutputBytes: number
): ToolExecutionResult => {
  const stdout = capOutput(result.stdout, maxOutputBytes);
  const stderr = capOutput(result.stderr, maxOutputBytes);
  const sections = [
    `exit code: ${result.exitCode}`,
    `duration: ${durationMs} ms`,
  ];
  if (stdout !== "") {
    sections.push(`stdout:\n${stdout}`);
  }
  if (stderr !== "") {
    sections.push(`stderr:\n${stderr}`);
  }
  if (stdout === "" && stderr === "") {
    sections.push("(no output)");
  }
  return textResult(sections.join("\n\n"), result.exitCode !== 0);
};

/** The run_script tool. It runs a library script, or inline code, in a hosted sandbox. */
export const runScriptExtension = (deps: RunScriptDeps): Extension => {
  const limits = deps.limits ?? SCRIPT_LIMITS;
  const run = defineTool({
    description: `Runs JavaScript or TypeScript and returns its exit code, duration, stdout and stderr. Give either path, a .ts, .mts, .js or .mjs file in the library (a relative path starts in your home folder), or code with language ts or js. args become process.argv from index 2, and stdin is the global string \`stdin\`. The script can import other library files by relative path with the extension, as in ./lib.ts. It has the global \`library\`: read(path) returns the text of a file, write(path, textOrBytes) writes a file, and list(dir) returns entries with name and kind. Paths work like the paths of your file tools, and the usual library rights apply. fetch works when network access is on for this agent. When it is off, fetch fails with "Network access is off for this agent." Secret placeholders work in fetch as they do in web_fetch. npm packages, https imports and Node built-ins such as fs and child_process are not available. Top-level await works. A run lasts at most ${limits.timeoutMs / 1000} seconds and makes at most 50 library and network calls, and stdout and stderr are each capped at ${limits.maxOutputBytes / 1024} KB.`,
    execute: async (args) => {
      const request = requestOf(args);
      if ("problem" in request) {
        return textResult(request.problem, true);
      }
      const home = await deps.homeOf();
      const source =
        request.kind === "library"
          ? await libraryScript(deps.read, home, request.path)
          : inlineScript(home, request.code, request.language);
      if ("problem" in source) {
        return textResult(source.problem, true);
      }
      const files = await collectFiles(deps.read, source.entry);
      if ("problem" in files) {
        return textResult(files.problem, true);
      }
      const sandbox = await deps.sandboxOf();
      const startedAt = Date.now();
      let result: SandboxRunResult;
      try {
        result = await runWithSafetyNet(
          sandbox.run({
            args: args.args ?? [],
            entry: source.entry.path,
            files,
            hosted: true,
            maxOutputBytes: limits.maxOutputBytes,
            skill: "library",
            stdin: args.stdin ?? "",
            timeoutMs: limits.timeoutMs,
          }),
          limits
        );
      } catch (error) {
        return textResult(`The sandbox failed: ${errorText(error)}`, true);
      }
      const durationMs = Date.now() - startedAt;
      try {
        await deps.record({
          durationMs,
          exitCode: result.exitCode,
          script: source.script,
          stderrBytes: encoder.encode(result.stderr).byteLength,
          stdoutBytes: encoder.encode(result.stdout).byteLength,
        });
      } catch {
        // A failed log entry does not change the result.
      }
      return describeRun(result, durationMs, limits.maxOutputBytes);
    },
    name: TOOL_NAME,
    parameters: Type.Object({
      args: Type.Optional(Type.Array(Type.String())),
      code: Type.Optional(Type.String()),
      language: Type.Optional(
        Type.Union([Type.Literal("ts"), Type.Literal("js")])
      ),
      path: Type.Optional(Type.String()),
      stdin: Type.Optional(Type.String()),
    }),
    replay: "unsafe",
  });

  return { name: RUN_SCRIPT_EXTENSION, tools: [run] };
};
