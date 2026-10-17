import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { SkillSummary, SkillsPort } from "../pi-run-skills.ts";
import {
  type SandboxFile,
  type SandboxRunInput,
  type SandboxRunResult,
  type SkillScriptSandbox,
  TIMEOUT_EXIT_CODE,
} from "./sandbox-port.ts";

export const SKILL_SCRIPTS_EXTENSION = "hm-skill-scripts";

const SECTION_KEY = "skill-scripts";
const TOOL_NAME = "run_skill_script";
const SKILL_FILE = "SKILL.md";
const SCRIPT_PATTERN = /\.(?:ts|mts|js|mjs)$/;

export interface ScriptLimits {
  /** Extra time the safety net waits after `timeoutMs` before it gives up on the sandbox. */
  graceMs: number;
  /** The most bytes kept of each of stdout and stderr. */
  maxOutputBytes: number;
  /** Wall time for one run. */
  timeoutMs: number;
}

/** The sentences of the tool's guidance that depend on where the script runs. */
export interface ScriptTexts {
  /** The tool description's sentence on what the script can import and use. */
  capabilities: string;
  /** What the script sees when the agent was granted secrets. The time cap is added after it. */
  granted: string;
  /** What the script sees when the agent has no secrets. The time cap is added after it. */
  plain: string;
}

export const ISOLATE_SCRIPT_TEXTS: ScriptTexts = {
  capabilities:
    "The script can import its own skill files (write the file extension, as in ./lib.ts) and use standard web APIs and fetch. No other packages.",
  granted:
    "The script sees only the skill's own files and has network access. It has no secrets of its own: the environment variables the agent was granted are set in process.env, and requests to hosts the agent has a credential for get that credential added for it. It runs for at most",
  plain:
    "The script sees only the skill's own files, has network access and no secrets, and runs for at most",
};

export const SCRIPT_LIMITS: ScriptLimits = {
  // The Linux VM stops a command at the wall time, 2 s later when it ignores TERM, and its last resort comes 3 s after that (the time to start a cold VM comes on top).
  graceMs: 6000,
  maxOutputBytes: 64 * 1024,
  timeoutMs: 30_000,
};

/** What one run of a script is granted. `mask` replaces every granted value in a text, so none reaches the model. */
export interface ScriptSecrets {
  forRun: () => Promise<{
    env: Record<string, string>;
    mask: (text: string) => string;
    proxy: boolean;
  }>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const textResult = (text: string, isError = false): ToolExecutionResult => ({
  isError,
  output: [{ text, type: "text" }],
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const folderPrefix = (skill: SkillSummary): string => `${skill.name}/`;

/** The skill's files relative to its folder, SKILL.md included, e.g. "scripts/hello.ts". */
const relativePathsOf = (skill: SkillSummary): string[] => {
  const prefix = folderPrefix(skill);
  return [
    SKILL_FILE,
    ...skill.files.map((path) =>
      path.startsWith(prefix) ? path.slice(prefix.length) : path
    ),
  ];
};

const hasEscape = (path: string): boolean =>
  path.startsWith("/") || path.split("/").includes("..");

/** The skill-relative file that `path` names, or undefined. A `<skill>/` prefix counts only when the path as given is not a file. */
const resolveEntry = (
  skill: SkillSummary,
  path: string
): string | undefined => {
  const files = new Set(relativePathsOf(skill));
  if (files.has(path)) {
    return path;
  }
  const prefix = folderPrefix(skill);
  if (path.startsWith(prefix) && files.has(path.slice(prefix.length))) {
    return path.slice(prefix.length);
  }
};

const readSkillFiles = (
  port: SkillsPort,
  skill: SkillSummary
): Promise<SandboxFile[]> =>
  Promise.all(
    relativePathsOf(skill).map(async (path) => ({
      bytes: await port.read(`${folderPrefix(skill)}${path}`),
      path,
    }))
  );

/** UTF-8 continuation bytes are 0x80 to 0xBF. */
const isContinuationByte = (byte: number): boolean =>
  byte >= 0x80 && byte < 0xc0;

/** The first `max` bytes of `text`, cut back to a character boundary, with a note when anything was cut. */
const capOutput = (text: string, max: number): string => {
  const bytes = encoder.encode(text);
  if (bytes.length <= max) {
    return text;
  }
  let end = max;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1;
  }
  const kept = decoder.decode(bytes.subarray(0, end));
  return `${kept}\n[truncated: showing the first ${max} of ${bytes.length} bytes]`;
};

const describeResult = (
  result: SandboxRunResult,
  maxOutputBytes: number
): ToolExecutionResult => {
  const stdout = capOutput(result.stdout, maxOutputBytes);
  const stderr = capOutput(result.stderr, maxOutputBytes);
  const sections = [`exit code: ${result.exitCode}`];
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

/** Races the run against a timer, so a sandbox that never settles still ends. */
const runWithSafetyNet = async (
  run: Promise<SandboxRunResult>,
  limits: ScriptLimits
): Promise<SandboxRunResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SandboxRunResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          exitCode: TIMEOUT_EXIT_CODE,
          stderr: `timed out after ${limits.timeoutMs / 1000} s`,
          stdout: "",
        }),
      limits.timeoutMs + limits.graceMs
    );
  });
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
};

/** Runs the script and describes what it printed. `mask`, when set, hides granted values before the output is capped. */
const runInSandbox = async (
  sandbox: SkillScriptSandbox,
  input: SandboxRunInput,
  mask: ((text: string) => string) | undefined,
  limits: ScriptLimits
): Promise<ToolExecutionResult> => {
  try {
    const result = await runWithSafetyNet(sandbox.run(input), limits);
    const shown =
      mask === undefined
        ? result
        : {
            exitCode: result.exitCode,
            stderr: mask(result.stderr),
            stdout: mask(result.stdout),
          };
    return describeResult(shown, limits.maxOutputBytes);
  } catch (error) {
    return textResult(`The sandbox failed: ${errorText(error)}`, true);
  }
};

/** The run_skill_script tool and its prompt section. With no skills, the extension adds nothing. */
export const skillScriptsExtension = (
  skills: readonly SkillSummary[],
  port: SkillsPort,
  sandbox: SkillScriptSandbox,
  secrets: ScriptSecrets | undefined,
  limits: ScriptLimits = SCRIPT_LIMITS,
  texts: ScriptTexts = ISOLATE_SCRIPT_TEXTS
): Extension => {
  if (skills.length === 0) {
    return { name: SKILL_SCRIPTS_EXTENSION };
  }
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const sandboxSentence = secrets === undefined ? texts.plain : texts.granted;
  const prompt = `Scripts written in TypeScript or JavaScript in a skill are run with ${TOOL_NAME}, not read and imitated. ${sandboxSentence} ${limits.timeoutMs / 1000} seconds.`;

  const run = defineTool({
    description: `Runs a skill's TypeScript or JavaScript script and returns its exit code, stdout and stderr. Give the path relative to the skill folder, as activate_skill lists it. args become process.argv from index 2. ${texts.capabilities}`,
    execute: async (args) => {
      const skill = skillsByName.get(args.skill);
      if (skill === undefined) {
        return textResult(`Skill not found: ${args.skill}`, true);
      }
      if (hasEscape(args.path)) {
        return textResult(`Invalid path: ${args.path}`, true);
      }
      const entry = resolveEntry(skill, args.path);
      if (entry === undefined) {
        return textResult(`Not a file of the skill: ${args.path}`, true);
      }
      if (!SCRIPT_PATTERN.test(entry)) {
        return textResult(
          `Not a script (.ts, .mts, .js, .mjs): ${entry}`,
          true
        );
      }
      let files: SandboxFile[];
      try {
        files = await readSkillFiles(port, skill);
      } catch (error) {
        return textResult(
          `Could not read the skill files: ${errorText(error)}`,
          true
        );
      }
      let granted: Awaited<ReturnType<ScriptSecrets["forRun"]>> | undefined;
      if (secrets !== undefined) {
        try {
          granted = await secrets.forRun();
        } catch (error) {
          return textResult(
            `Could not read the secrets: ${errorText(error)}`,
            true
          );
        }
      }
      return runInSandbox(
        sandbox,
        {
          args: args.args ?? [],
          entry,
          files,
          maxOutputBytes: limits.maxOutputBytes,
          ...(granted === undefined
            ? {}
            : { env: granted.env, proxy: granted.proxy }),
          skill: skill.name,
          timeoutMs: limits.timeoutMs,
        },
        granted?.mask,
        limits
      );
    },
    name: TOOL_NAME,
    parameters: Type.Object({
      args: Type.Optional(Type.Array(Type.String())),
      path: Type.String(),
      skill: Type.Union(skills.map((skill) => Type.Literal(skill.name))),
    }),
    replay: "unsafe",
  });

  return {
    name: SKILL_SCRIPTS_EXTENSION,
    sections: [{ key: SECTION_KEY, render: () => prompt }],
    tools: [run],
  };
};
