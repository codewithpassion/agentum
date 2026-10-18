import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createMemoryRemote,
  type MemoryRemote,
} from "@repo/library-sync/testing";
import {
  ATTACHMENT_MARKER_RE,
  extractAttachmentMarkers,
  formatAttachmentMarker,
} from "@repo/protocol/attachments";
import type {
  ClaimResponse,
  CompleteRequest,
  RunEventInput,
} from "@repo/protocol/machine";
import type { Masker } from "@repo/protocol/masker";
import {
  AGENT_DD,
  AGENT_HEAD,
  AGENT_HOME,
  AGENT_MKDIR,
  AGENT_REALPATH,
  AGENT_RM,
  AGENT_STAT,
  AS_AGENT,
} from "./agent-user.ts";
import type { Timers } from "./client.ts";
import type { CommandRunner } from "./command.ts";
import { type ExecuteRunDeps, executeRun, type QueryFn } from "./executor.ts";
import type { FilesApi } from "./files-api.ts";
import type { LibraryApi } from "./library-api.ts";
import type { Logger } from "./log.ts";
import { createRunApi, type RunApi, RunApiError } from "./run-api.ts";
import type { SkillsApi } from "./skills-api.ts";
import { workDirPath } from "./workdir.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CLAIM_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "protocol",
  "fixtures",
  "claim-response.json"
);
const MACHINE_ID = "mch_test";
const RUN_TOKEN = "hm_run_7Fq2KxR9mWt4LpZc1Ns8VbYd";
const CREDENTIAL = "hm_mach_secret_for_tests";

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

const claimWith = (
  change: (claim: ClaimResponse) => void = () => undefined
) => {
  const claim = readJson(CLAIM_FIXTURE) as ClaimResponse;
  claim.session = {
    id: claim.session.id,
    runtimeMachineId: null,
    runtimeRef: null,
  };
  // The fixture lists one input file; most tests run without any.
  claim.inputFileIds = [];
  change(claim);
  return claim;
};

/** What `tick` stands for in a scripted SDK stream: the 500 ms batch timer fires. */
const TICK = "tick";
/** The library checkpoint timer fires, and the stream waits until the sync it started is done. */
const CHECKPOINT = "checkpoint";
type Step = SDKMessage | typeof TICK | typeof CHECKPOINT;

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
  exit(code: number | null) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const fakeTimers = () => {
  interface Pending {
    delay: number;
    fn: () => void;
    id: number;
    label: string;
  }
  let nextId = 0;
  let pending: Pending[] = [];
  const add = (delay: number, fn: () => void, label = "") => {
    nextId += 1;
    const timer = { delay, fn, id: nextId, label };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other.id !== timer.id);
    };
  };
  const timers: Timers = {
    after: (ms, fn, label) => add(ms, fn, label),
    every: (ms, fn, label) => add(ms, fn, label),
  };
  return {
    fire: (label: string) => {
      for (const timer of pending.filter((other) => other.label === label)) {
        timer.fn();
      }
    },
    has: (label: string) => pending.some((timer) => timer.label === label),
    timers,
  };
};

/** What the fake files API serves: a name and text per file id, or a status to answer instead. */
type FakeDownloads = Record<string, { name: string; text: string } | number>;

interface Harness {
  completions: { body: CompleteRequest; processExited: boolean }[];
  downloaded: string[];
  events: RunEventInput[][];
  /** The files in `inbox/` and `.claude/skills/` (name to text) when the first message was read. */
  firstMessage: {
    inbox: Record<string, string> | undefined;
    skills: Record<string, string> | undefined;
  };
  heartbeat: { reject: unknown };
  lines: string[];
  maskerSeen: Masker[];
  optionsSeen: Options[];
  order: string[];
  /** The names the process spawner was asked to preserve, one entry per spawn. */
  preserveEnvSeen: (readonly string[])[];
  proc: FakeProcess;
  /** The conflicts the run reported to the Worker. */
  recordedConflicts: { conflictPath: string; path: string }[];
  /** What the fake hm-agent work directory holds (path to text), as the sudo calls left it. */
  remoteFiles: Map<string, string>;
  run: CommandRunner;
  runCommands: string[][];
  sendStderr: (text: string) => void;
  timers: ReturnType<typeof fakeTimers>;
  /** What the fake files API received. */
  uploaded: { name: string; text: string }[];
}

interface SetupOptions {
  claim?: ClaimResponse;
  claudeBinary?: string | null;
  /** Files the fake files API serves. */
  downloads?: FakeDownloads;
  /** Keeps the stream open after the script until an abort. */
  hang?: boolean;
  /** Keeps the process alive after an abort until the test lets it go. */
  holdExit?: boolean;
  /** The library the run syncs with. The claim names the paths to sync. */
  library?: {
    /** Runs once the first message is read, with the work directory: the agent working. */
    agent?: (workDir: string, remote: MemoryRemote) => void;
    /** The listing fails, as a Worker outage would make it. */
    down?: boolean;
    remote: MemoryRemote;
  };
  /** `setMcpServers` answers only once the query is closed. */
  mcpHangsUntilClose?: boolean;
  /** Files already in the fake hm-agent work directory, by absolute path. */
  remoteFiles?: Record<string, string>;
  script: Step[];
  singleUser?: boolean;
  /** The skills the fake Worker lists, or `listFails`: the HTTP status the list answers with. */
  skills?: { files: { path: string; text: string }[]; listFails?: number };
  /** The process fails to start: `error` and no `exit`, as Bun reports it. */
  spawnFails?: boolean;
  /** Written to stderr once the process has started. */
  stderr?: string;
  /** Uploads answer with this status instead of 201. */
  uploadStatus?: number;
  /** When set, the run talks to the relay through the real run API client over this fetch. */
  wireFetch?: typeof fetch;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hm-exec-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

/** The files in `<cwd>/inbox`, name to text; undefined when there is no such directory. */
const readInbox = (
  cwd: string | undefined
): Record<string, string> | undefined => {
  const inbox = join(cwd ?? "", "inbox");
  if (cwd === undefined || !existsSync(inbox)) {
    return;
  }
  return Object.fromEntries(
    readdirSync(inbox).map((name) => [
      name,
      readFileSync(join(inbox, name), "utf8"),
    ])
  );
};

/** The files under `<cwd>/.claude/skills`, relative path to text; undefined when there is no such directory. */
const readSkills = (
  cwd: string | undefined
): Record<string, string> | undefined => {
  const skills = join(cwd ?? "", ".claude", "skills");
  if (cwd === undefined || !existsSync(skills)) {
    return;
  }
  return Object.fromEntries(
    readdirSync(skills, { recursive: true })
      .map(String)
      .filter((name) => statSync(join(skills, name)).isFile())
      .map((name) => [name, readFileSync(join(skills, name), "utf8")])
  );
};

const abortError = () =>
  Object.assign(new Error("Claude Code process aborted by user"), {
    name: "AbortError",
  });

const setup = (setupOptions: SetupOptions) => {
  const claim = setupOptions.claim ?? claimWith();
  const timers = fakeTimers();
  const proc = new FakeProcess();
  const order: string[] = [];
  const optionsSeen: Options[] = [];
  const completions: Harness["completions"] = [];
  const events: RunEventInput[][] = [];
  const lines: string[] = [];
  const runCommands: string[][] = [];
  const heartbeat: Harness["heartbeat"] = { reject: undefined };
  const downloaded: string[] = [];
  const uploaded: Harness["uploaded"] = [];
  const firstMessage: Harness["firstMessage"] = {
    inbox: undefined,
    skills: undefined,
  };
  let stderr: (text: string) => void = () => undefined;
  let closeQuery: () => void = () => undefined;
  const maskerSeen: Masker[] = [];
  const preserveEnvSeen: (readonly string[])[] = [];
  const recordedConflicts: Harness["recordedConflicts"] = [];

  const api: RunApi = {
    claim: () => Promise.reject(new Error("not used")),
    complete: (body) => {
      order.push(`complete:${body.status}`);
      completions.push({ body, processExited: proc.exitCode !== null });
      return Promise.resolve();
    },
    events: (batch) => {
      events.push(batch);
      return Promise.resolve();
    },
    heartbeat: () =>
      heartbeat.reject === undefined
        ? Promise.resolve()
        : Promise.reject(heartbeat.reject),
  };

  const filesApi: FilesApi = {
    download: (fileId) => {
      downloaded.push(fileId);
      const served = setupOptions.downloads?.[fileId];
      if (served === undefined || typeof served === "number") {
        return Promise.reject(
          new RunApiError(
            `files download answered HTTP ${served ?? 404}`,
            served ?? 404
          )
        );
      }
      return Promise.resolve({
        body: new Blob([served.text]),
        name: served.name,
      });
    },
    upload: async (file) => {
      const text = await file.body.text();
      uploaded.push({ name: file.name, text });
      if (setupOptions.uploadStatus !== undefined) {
        throw new RunApiError(
          `files upload answered HTTP ${setupOptions.uploadStatus}`,
          setupOptions.uploadStatus
        );
      }
      return { id: `file-${uploaded.length}` };
    },
  };

  const queryFn: QueryFn = ({ options, prompt }) => {
    if (options === undefined) {
      throw new Error("the executor must pass options");
    }
    optionsSeen.push(options);
    const { cwd } = options;
    const signal = options.abortController?.signal;
    const spawned = options.spawnClaudeCodeProcess?.({
      args: [],
      command: "claude",
      cwd: options.cwd,
      env: options.env ?? {},
      signal: signal ?? new AbortController().signal,
    });
    if (spawned === undefined) {
      throw new Error(
        "the executor must start Claude Code through the SDK hook"
      );
    }
    if (setupOptions.stderr !== undefined) {
      stderr(setupOptions.stderr);
    }
    if (setupOptions.spawnFails) {
      proc.emit("error", new Error("spawn /usr/local/bin/claude EACCES"));
    }
    signal?.addEventListener("abort", () => {
      proc.kill("SIGTERM");
      if (!setupOptions.holdExit) {
        proc.exit(null);
      }
    });

    async function* stream(): AsyncGenerator<SDKMessage> {
      if (setupOptions.spawnFails) {
        throw new Error("Failed to spawn Claude Code process: EACCES");
      }
      const first = await (prompt as AsyncIterable<SDKUserMessage>)
        [Symbol.asyncIterator]()
        .next();
      const content = first.done ? "(none)" : first.value.message.content;
      order.push(`first-message:${String(content)}`);
      firstMessage.inbox = readInbox(cwd);
      firstMessage.skills = readSkills(cwd);
      if (cwd !== undefined) {
        setupOptions.library?.agent?.(cwd, setupOptions.library.remote);
      }
      for (const step of setupOptions.script) {
        if (signal?.aborted) {
          throw abortError();
        }
        if (step === CHECKPOINT) {
          timers.fire("library-checkpoint");
          // The sync runs on real file calls and fake HTTP; give it time to finish.
          // biome-ignore lint/performance/noAwaitInLoops: the stream plays its steps in order.
          await sleep(50);
        } else if (step === TICK) {
          timers.fire("event-batch");
          // Let the batch go out before the next message is pushed.
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          yield step;
        }
      }
      if (setupOptions.hang) {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()));
        });
      }
      const gotResult = setupOptions.script.some(
        (step) => step !== TICK && step !== CHECKPOINT && step.type === "result"
      );
      proc.exit(gotResult ? 0 : 1);
    }

    const iterator = stream();
    const fakeQuery = {
      [Symbol.asyncIterator]: () => iterator,
      close: () => {
        order.push("close");
        closeQuery();
      },
      setMcpServers: (servers: Record<string, unknown>) => {
        order.push(`setMcpServers:${Object.keys(servers).join(",")}`);
        if (setupOptions.mcpHangsUntilClose) {
          return new Promise((resolve) => {
            closeQuery = () =>
              resolve({
                added: [],
                errors: { harbourmaster: "closed" },
                removed: [],
              });
          });
        }
        return Promise.resolve({
          added: Object.keys(servers),
          errors: {},
          removed: [],
        });
      },
    };
    return fakeQuery as unknown as Query;
  };

  // The fake hm-agent work directory: `dd` writes its stdin, `head` reads a
  // file back, `realpath` and `stat` answer for the paths that exist.
  const remoteFiles = new Map(Object.entries(setupOptions.remoteFiles ?? {}));
  const remoteWorkDir = remoteWorkDirOf(claim);
  const ok = { exitCode: 0, stderr: "", stdout: "" };
  const missing = { exitCode: 1, stderr: "no such file", stdout: "" };
  const run: CommandRunner = (command, stdin) => {
    runCommands.push(command);
    const [tool, ...args] = command.slice(AS_AGENT.length);
    const path = args.at(-1) ?? "";
    switch (tool) {
      case AGENT_DD: {
        const target = args.find((arg) => arg.startsWith("of="))?.slice(3);
        order.push(`write:${target}`);
        remoteFiles.set(target ?? "", new TextDecoder().decode(stdin));
        return Promise.resolve(ok);
      }
      case AGENT_HEAD: {
        const text = remoteFiles.get(path);
        return Promise.resolve(
          text === undefined
            ? missing
            : {
                ...ok,
                stdout: text,
                stdoutBytes: new TextEncoder().encode(text),
              }
        );
      }
      case AGENT_REALPATH:
        return Promise.resolve(
          path === remoteWorkDir || remoteFiles.has(path)
            ? { ...ok, stdout: `${path}\n` }
            : missing
        );
      case AGENT_STAT: {
        const text = remoteFiles.get(path);
        return Promise.resolve(
          text === undefined
            ? missing
            : {
                ...ok,
                stdout: `${new TextEncoder().encode(text).length} 81a4\n`,
              }
        );
      }
      default:
        return Promise.resolve(ok);
    }
  };
  const encoder = new TextEncoder();
  const skills = setupOptions.skills ?? { files: [] };
  const skillsApi: SkillsApi = {
    file: (path) => {
      const found = skills.files.find((file) => file.path === path);
      return found === undefined
        ? Promise.reject(new RunApiError("skills file answered HTTP 404", 404))
        : Promise.resolve(encoder.encode(found.text));
    },
    list: () => {
      const { listFails } = skills;
      if (listFails !== undefined) {
        return Promise.reject(
          new RunApiError(`skills list answered HTTP ${listFails}`, listFails)
        );
      }
      return Promise.resolve(
        skills.files.map((file) => ({
          etag: `"${file.path}"`,
          path: file.path,
          size: encoder.encode(file.text).length,
        }))
      );
    },
  };
  const log: Logger = {
    error: (message) => lines.push(message),
    info: (message) => lines.push(message),
  };
  const libraryRemote = setupOptions.library
    ? setupOptions.library.remote
    : createMemoryRemote();
  const libraryApi: LibraryApi = {
    ...libraryRemote,
    list: (dir) =>
      setupOptions.library?.down
        ? Promise.reject(new RunApiError("library list answered HTTP 503", 503))
        : libraryRemote.list(dir),
    recordConflict: (conflict) => {
      recordedConflicts.push(conflict);
      return Promise.resolve();
    },
    write: (path, bytes, options) => {
      order.push(`library-write:${path}:exited=${proc.exitCode !== null}`);
      return libraryRemote.write(path, bytes, options);
    },
  };
  const deps: ExecuteRunDeps = {
    claim,
    config: {
      claudeBinary:
        setupOptions.claudeBinary === undefined
          ? "/usr/local/bin/claude"
          : setupOptions.claudeBinary,
      credential: CREDENTIAL,
      machineId: MACHINE_ID,
      singleUser: setupOptions.singleUser ?? true,
    },
    createApi: (masker) => {
      maskerSeen.push(masker);
      if (setupOptions.wireFetch !== undefined) {
        return createRunApi({
          credential: CREDENTIAL,
          fetch: setupOptions.wireFetch,
          masker,
          runId: claim.run.id,
          server: "https://harbourmaster.example.workers.dev",
        });
      }
      return api;
    },
    createFilesApi: () => filesApi,
    createLibraryApi: () => libraryApi,
    createSkillsApi: () => skillsApi,
    daemonHome: home,
    env: {
      ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      HM_CREDENTIAL: CREDENTIAL,
      HOME: "/home/dom",
      PATH: "/usr/bin",
    },
    log,
    queryFn,
    run,
    spawnProcessFor: (onStderr, preserveEnv) => {
      stderr = onStderr;
      preserveEnvSeen.push(preserveEnv);
      return () => proc as unknown as SpawnedProcess;
    },
    timers: timers.timers,
  };
  const execution = executeRun(deps);
  const harness: Harness = {
    completions,
    downloaded,
    events,
    firstMessage,
    heartbeat,
    lines,
    maskerSeen,
    optionsSeen,
    order,
    preserveEnvSeen,
    proc,
    recordedConflicts,
    remoteFiles,
    run,
    runCommands,
    sendStderr: (text) => stderr(text),
    timers,
    uploaded,
  };
  return { ...harness, claim, execution };
};

const toolRun = readJson(join(FIXTURES, "tool-run", "sdk-messages.json")) as [
  SDKMessage,
  ...SDKMessage[],
];
const [INIT] = toolRun;
/** Ticks after the first assistant message, mid-run, and at the end, so the batches differ. */
const toolRunScript = (): Step[] => {
  const steps: Step[] = [];
  toolRun.forEach((message, index) => {
    steps.push(message);
    if (index === 2 || index === 5) {
      steps.push(TICK);
    }
  });
  return steps;
};

/** The stored golden; with UPDATE_GOLDENS set it is first rewritten from `actual`. */
const goldenFor = <T>(name: string, actual: T): T => {
  const path = join(FIXTURES, "tool-run", name);
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
  }
  return readJson(path) as T;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls without a loop, so a test fails by timeout and not by hanging. */
const until = async (check: () => boolean): Promise<void> => {
  if (check()) {
    return;
  }
  await sleep(1);
  await until(check);
};

describe("a run that uses tools", () => {
  test("the event batches and the completion match the goldens", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.events).toEqual(goldenFor("events.json", run.events));
    const bodies = run.completions.map((entry) => entry.body);
    expect(bodies).toEqual(goldenFor("complete.json", bodies));
  });

  test("the completion is posted after the process exits, and once", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.completions).toHaveLength(1);
    expect(run.completions[0]?.processExited).toBe(true);
  });

  test("the heartbeat and the batch timer stop when the run ends", async () => {
    const run = setup({ script: toolRunScript() });
    expect(run.timers.has("heartbeat")).toBe(true);
    await run.execution.finished;
    expect(run.timers.has("heartbeat")).toBe(false);
    expect(run.timers.has("event-batch")).toBe(false);
  });
});

describe("the options passed to query", () => {
  test("carry the permission mode, strict MCP, the instructions and no MCP servers", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const [options] = run.optionsSeen;
    expect(options).toBeDefined();
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.settingSources).toEqual(["project"]);
    expect(options?.systemPrompt).toEqual({
      append: expect.stringContaining(run.claim.instructions),
      preset: "claude_code",
      type: "preset",
    });
    expect(options?.model).toBe(run.claim.agent.model);
    expect(options?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options?.canUseTool).toBeUndefined();
    expect(options && "mcpServers" in options).toBe(false);
  });

  test("the system prompt ends with the attachment line, after the agent's instructions", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const [options] = run.optionsSeen;
    const prompt = options?.systemPrompt;
    const append =
      typeof prompt === "object" && prompt !== null && "append" in prompt
        ? (prompt.append ?? "")
        : "";
    expect(append.startsWith(run.claim.instructions)).toBe(true);
    const filesSection = append.slice(run.claim.instructions.length).trim();
    expect(filesSection).toContain("on its own line in your final answer");
    expect(filesSection).toContain(
      `A file can only be attached from inside ${workDirOf(run.claim)}.`
    );
    // The marker in the sentence is one the parser accepts, with a path slot.
    const [marker] = filesSection.match(ATTACHMENT_MARKER_RE) ?? [];
    expect(marker).toBe(formatAttachmentMarker("<absolute path>"));
    expect(extractAttachmentMarkers(`ok\n${marker}`).paths).toEqual([
      "<absolute path>",
    ]);
  });

  test("the append names home (the work dir), scratch (<workDir>/tmp, emptied per run) and the library tools", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const [options] = run.optionsSeen;
    const prompt = options?.systemPrompt;
    const append =
      typeof prompt === "object" && prompt !== null && "append" in prompt
        ? (prompt.append ?? "")
        : "";
    const workDir = workDirOf(run.claim);
    expect(append).toContain(`- Home: ${workDir}.`);
    expect(append).toContain(`- Scratch: ${workDir}/tmp.`);
    expect(append).toContain("emptied before your next run");
    expect(append).toContain("- Library:");
    expect(append).toContain("reach it with the library tools");
  });

  test("the env is filtered and holds no run token", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const env = run.optionsSeen[0]?.env ?? {};
    expect(env).toEqual({ HOME: "/home/dom", PATH: "/usr/bin" });
    expect(JSON.stringify(run.optionsSeen[0])).not.toContain("hm_run_");
  });

  test("the budget comes from the agent config", async () => {
    const claim = claimWith((c) => {
      c.agent.runtimeConfig = { maxBudgetUsd: 1.5 };
    });
    const run = setup({ claim, script: toolRunScript() });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.maxBudgetUsd).toBe(1.5);
    const other = setup({ script: toolRunScript() });
    await other.execution.finished;
    expect(other.optionsSeen[0] && "maxBudgetUsd" in other.optionsSeen[0]).toBe(
      false
    );
  });

  test("the working directory is under the agent's home layout", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.cwd).toBe(
      join(
        home,
        "harbourmaster",
        run.claim.run.workspaceId,
        run.claim.run.agentId,
        "work"
      )
    );
  });

  test("multi-user mode prepares the directory through sudo as hm-agent", async () => {
    const run = setup({ script: toolRunScript(), singleUser: false });
    await run.execution.finished;
    expect(run.runCommands.map((command) => command.slice(0, 5))).toEqual([
      ["sudo", "-n", "-u", "hm-agent", "/bin/mkdir"],
      ["sudo", "-n", "-u", "hm-agent", "/bin/rm"],
      ["sudo", "-n", "-u", "hm-agent", "/bin/mkdir"],
    ]);
    expect(
      run.optionsSeen[0]?.cwd?.startsWith("/home/hm-agent/harbourmaster/")
    ).toBe(true);
  });
});

describe("the order of the first message", () => {
  test("setMcpServers gets the claim's map before the first message", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.order.slice(0, 2)).toEqual([
      "setMcpServers:harbourmaster",
      `first-message:${run.claim.run.inputText}`,
    ]);
  });
});

describe("resume", () => {
  const withSession = (machine: string | null, ref: string | null) =>
    claimWith((c) => {
      c.session = {
        id: c.session.id,
        runtimeMachineId: machine,
        runtimeRef: ref,
      };
    });

  test("is passed when the session's machine is this one", async () => {
    const run = setup({
      claim: withSession(MACHINE_ID, "sess-1"),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.resume).toBe("sess-1");
  });

  test("is left out for another machine", async () => {
    const run = setup({
      claim: withSession("mch_other", "sess-1"),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0] && "resume" in run.optionsSeen[0]).toBe(false);
  });

  test("is left out when there is no session yet", async () => {
    const run = setup({
      claim: withSession(MACHINE_ID, null),
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.optionsSeen[0] && "resume" in run.optionsSeen[0]).toBe(false);
  });
});

describe("aborting", () => {
  const untilStarted = (run: ReturnType<typeof setup>) =>
    until(() => run.order.some((entry) => entry.startsWith("first-message")));

  test("a heartbeat 409 kills the process and posts aborted only after it exits", async () => {
    const run = setup({ hang: true, holdExit: true, script: [INIT] });
    await untilStarted(run);
    run.heartbeat.reject = Object.assign(new Error("Run is not running"), {
      status: 409,
    });
    run.timers.fire("heartbeat");
    await sleep(10);
    expect(run.proc.signals).toContain("SIGTERM");
    expect(run.completions).toHaveLength(0);
    run.proc.exit(143);
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.completions[0]?.processExited).toBe(true);
  });

  test("a stuck process gets SIGKILL after the grace period", async () => {
    const run = setup({ hang: true, holdExit: true, script: [INIT] });
    await untilStarted(run);
    run.execution.abort("relay connection replaced");
    await sleep(10);
    // The SDK's SIGTERM did not help: the executor waits, then escalates.
    expect(run.timers.has("kill")).toBe(true);
    expect(run.completions).toHaveLength(0);
    run.timers.fire("kill");
    expect(run.proc.signals.at(-1)).toBe("SIGKILL");
    run.proc.exit(137);
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
  });

  test("an abort while the MCP servers are being handed over still posts aborted", async () => {
    const run = setup({
      hang: true,
      mcpHangsUntilClose: true,
      script: toolRunScript(),
    });
    await until(() => run.order.includes("setMcpServers:harbourmaster"));
    run.execution.abort("relay connection replaced");
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.order).toContain("close");
  });

  test("an abort before the run started posts aborted without starting Claude Code", async () => {
    const run = setup({ hang: true, script: toolRunScript() });
    run.execution.abort("cancelled");
    await run.execution.finished;
    expect(run.completions.map((entry) => entry.body)).toEqual([
      { status: "aborted" },
    ]);
    expect(run.order).not.toContain(`first-message:${run.claim.run.inputText}`);
  });
});

/** A successful result whose answer is `text`. */
const answer = (text: string): SDKMessage =>
  ({ ...(toolRun.at(-1) as object), result: text }) as unknown as SDKMessage;

/** The work directory of the claim `setup` uses by default (single-user, under `home`). */
const workDirOf = (claim: ClaimResponse): string =>
  workDirPath(home, claim.run.workspaceId, claim.run.agentId);

/** The work directory of a multi-user run: hm-agent's home. */
const remoteWorkDirOf = (claim: ClaimResponse): string =>
  workDirPath(AGENT_HOME, claim.run.workspaceId, claim.run.agentId);

const doneBody = (run: { completions: Harness["completions"] }) => {
  const body = run.completions[0]?.body;
  if (body?.status !== "done") {
    throw new Error(`expected a done completion, got ${body?.status}`);
  }
  return body;
};

describe("input files", () => {
  const twoFiles = () =>
    claimWith((c) => {
      c.inputFileIds = ["file-a", "file-b"];
    });

  test("both are on disk before the first message, which names their paths", async () => {
    const run = setup({
      claim: twoFiles(),
      downloads: {
        "file-a": { name: "notes.txt", text: "alpha" },
        "file-b": { name: "data.csv", text: "beta" },
      },
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.downloaded.sort()).toEqual(["file-a", "file-b"]);
    expect(run.firstMessage.inbox).toEqual({
      "data.csv": "beta",
      "notes.txt": "alpha",
    });
    const first = run.order.find((entry) => entry.startsWith("first-message:"));
    expect(first).toContain(run.claim.run.inputText);
    expect(first).toContain("- inbox/notes.txt");
    expect(first).toContain("- inbox/data.csv");
    expect(doneBody(run).status).toBe("done");
  });

  test("two files with one name both land, the second under its id", async () => {
    const run = setup({
      claim: twoFiles(),
      downloads: {
        "file-a": { name: "same.txt", text: "one" },
        "file-b": { name: "same.txt", text: "two" },
      },
      script: toolRunScript(),
    });
    await run.execution.finished;
    expect(run.firstMessage.inbox).toEqual({
      "file-b-same.txt": "two",
      "same.txt": "one",
    });
  });

  test("a run without input files gets its text unchanged and no inbox", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.downloaded).toEqual([]);
    expect(run.firstMessage.inbox).toBeUndefined();
    expect(run.order).toContain(`first-message:${run.claim.run.inputText}`);
  });

  test("a file the Worker refuses (404) fails the run before Claude Code starts, naming the id", async () => {
    const run = setup({
      claim: twoFiles(),
      downloads: { "file-a": { name: "notes.txt", text: "alpha" } },
      script: toolRunScript(),
    });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain("file-b");
    expect(run.optionsSeen).toHaveLength(0);
  });
});

describe("files on a multi-user machine", () => {
  test("each input file is written through sudo before Claude Code starts, and the first message names it", async () => {
    const claim = claimWith((c) => {
      c.inputFileIds = ["file-a", "file-b"];
    });
    const run = setup({
      claim,
      downloads: {
        "file-a": { name: "notes.txt", text: "alpha" },
        "file-b": { name: "data.csv", text: "beta" },
      },
      script: toolRunScript(),
      singleUser: false,
    });
    await run.execution.finished;
    const inbox = `${remoteWorkDirOf(claim)}/inbox`;
    // The first three commands prepare the work directory.
    expect(run.runCommands.slice(3)).toEqual([
      [...AS_AGENT, AGENT_MKDIR, "-p", inbox],
      [...AS_AGENT, AGENT_DD, `of=${inbox}/notes.txt`, "status=none"],
      [...AS_AGENT, AGENT_MKDIR, "-p", inbox],
      [...AS_AGENT, AGENT_DD, `of=${inbox}/data.csv`, "status=none"],
    ]);
    expect(Object.fromEntries(run.remoteFiles)).toEqual({
      [`${inbox}/data.csv`]: "beta",
      [`${inbox}/notes.txt`]: "alpha",
    });
    const first = run.order.find((entry) => entry.startsWith("first-message:"));
    expect(first).toContain("- inbox/notes.txt");
    expect(first).toContain("- inbox/data.csv");
    expect(run.order.indexOf(`write:${inbox}/data.csv`)).toBeLessThan(
      run.order.indexOf(first ?? "")
    );
    expect(doneBody(run).status).toBe("done");
  });

  test("an attachment is read back through sudo and its id goes into the completion", async () => {
    const claim = claimWith();
    const run = setup({
      claim,
      remoteFiles: { [`${remoteWorkDirOf(claim)}/report.txt`]: "the report" },
      script: [INIT, answer("Done. [ATTACHMENT:report.txt]")],
      singleUser: false,
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([{ name: "report.txt", text: "the report" }]);
    const body = doneBody(run);
    expect(body.fileIds).toEqual(["file-1"]);
    expect(body.text).toBe("Done.");
  });

  test("a marker outside the work directory is refused with no sudo call for it", async () => {
    const run = setup({
      script: [INIT, answer("Here [ATTACHMENT:/etc/passwd]")],
      singleUser: false,
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([]);
    // Only the three commands that prepare the work directory ran.
    expect(run.runCommands.map((command) => command[AS_AGENT.length])).toEqual([
      AGENT_MKDIR,
      AGENT_RM,
      AGENT_MKDIR,
    ]);
    const body = doneBody(run);
    expect(body.fileIds).toBeUndefined();
    expect(body.text).toContain("[attachment refused: passwd]");
    expect(body.text).not.toContain("[ATTACHMENT:");
  });
});

describe("output files", () => {
  /** Puts `files` into the claim's work directory before the run starts. */
  const withWorkFiles = (files: Record<string, string>) => {
    const claim = claimWith();
    const workDir = workDirOf(claim);
    mkdirSync(workDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(workDir, name), text);
    }
    return claim;
  };

  test("a marker inside work/ is uploaded and its id goes into the completion", async () => {
    const claim = withWorkFiles({ "report.txt": "the report" });
    const run = setup({
      claim,
      script: [INIT, answer("Done. [ATTACHMENT:report.txt]")],
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([{ name: "report.txt", text: "the report" }]);
    const body = doneBody(run);
    expect(body.fileIds).toEqual(["file-1"]);
    expect(body.text).toBe("Done.");
  });

  test("an absolute path inside work/ works too", async () => {
    const claim = withWorkFiles({ "report.txt": "the report" });
    const path = join(workDirOf(claim), "report.txt");
    const run = setup({
      claim,
      script: [INIT, answer(`See [ATTACHMENT:${path}]`)],
    });
    await run.execution.finished;
    expect(doneBody(run).fileIds).toEqual(["file-1"]);
  });

  test("a marker outside work/ is refused: nothing is uploaded and the completion says so", async () => {
    const claim = withWorkFiles({});
    const outside = join(home, "secret.txt");
    writeFileSync(outside, "do not send");
    const run = setup({
      claim,
      script: [INIT, answer(`Here [ATTACHMENT:${outside}]`)],
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([]);
    const body = doneBody(run);
    expect(body.status).toBe("done");
    expect(body.fileIds).toBeUndefined();
    expect(body.text).toContain("[attachment refused: secret.txt]");
    expect(body.text).not.toContain("[ATTACHMENT:");
  });

  test("a symlink in work/ that points outside is refused", async () => {
    const claim = withWorkFiles({});
    const outside = join(home, "secret.txt");
    writeFileSync(outside, "do not send");
    symlinkSync(outside, join(workDirOf(claim), "link.txt"));
    const run = setup({
      claim,
      script: [INIT, answer("[ATTACHMENT:link.txt]")],
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([]);
    expect(doneBody(run).text).toContain("[attachment refused: link.txt]");
  });

  test("a missing file is reported and the run still completes", async () => {
    const run = setup({
      claim: withWorkFiles({}),
      script: [INIT, answer("[ATTACHMENT:nope.txt]")],
    });
    await run.execution.finished;
    expect(run.uploaded).toEqual([]);
    expect(doneBody(run).text).toContain("[attachment missing: nope.txt]");
  });

  test("a failed upload leaves the id out, notes it, and the run still completes", async () => {
    const run = setup({
      claim: withWorkFiles({ "report.txt": "the report" }),
      script: [INIT, answer("[ATTACHMENT:report.txt]")],
      uploadStatus: 413,
    });
    await run.execution.finished;
    const body = doneBody(run);
    expect(body.fileIds).toBeUndefined();
    expect(body.text).toContain("[attachment failed: report.txt]");
  });

  test("an error result is never scanned for markers", async () => {
    const claim = withWorkFiles({ "report.txt": "the report" });
    const result = {
      ...(toolRun.at(-1) as object),
      errors: ["[ATTACHMENT:report.txt]"],
      is_error: true,
      subtype: "error_max_budget_usd",
    } as unknown as SDKMessage;
    const run = setup({ claim, script: [INIT, result] });
    await run.execution.finished;
    expect(run.uploaded).toEqual([]);
    expect(run.completions[0]?.body.status).toBe("failed");
  });
});

describe("failures", () => {
  test("a process that cannot start posts failed instead of waiting for an exit", async () => {
    const run = setup({ script: [], spawnFails: true });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain("EACCES");
    expect(run.proc.signals).toEqual([]);
  });

  test("the run's masker hides the run token and the machine credential", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const [masker] = run.maskerSeen;
    expect(masker?.mask(`a ${RUN_TOKEN} b ${CREDENTIAL}`)).toBe(
      "a [secret:run_token] b [secret:machine_credential]"
    );
  });

  test("an error result posts failed with the error and the session", async () => {
    const result = {
      ...(toolRun.at(-1) as object),
      errors: ["Budget of $0.01 exceeded"],
      is_error: true,
      subtype: "error_max_budget_usd",
    } as unknown as SDKMessage;
    const run = setup({ script: [INIT, result] });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toBe(
      "Budget of $0.01 exceeded"
    );
  });

  test("a stream with no result posts failed and masks the run token from stderr", async () => {
    const run = setup({
      script: [INIT],
      stderr: `boom ${RUN_TOKEN} and ${CREDENTIAL}\n`,
    });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain(
      "boom [secret:run_token]"
    );
    expect(JSON.stringify(run.completions)).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(run.completions)).not.toContain(CREDENTIAL);
    expect(run.lines.join("\n")).not.toContain(RUN_TOKEN);
  });

  test("a machine without a claude binary fails the run with a clear error", async () => {
    const run = setup({ claudeBinary: null, script: [] });
    await run.execution.finished;
    const body = run.completions[0]?.body;
    expect(body?.status).toBe("failed");
    expect(body && "error" in body ? body.error : "").toContain(
      "claude binary"
    );
    expect(run.optionsSeen).toHaveLength(0);
  });
});

describe("skills", () => {
  const SKILLS = [
    { path: "a/SKILL.md", text: "# a" },
    { path: "b/SKILL.md", text: "# b" },
    { path: "b/helper.sh", text: "echo b" },
    { path: "shared/SKILL.md", text: "# shared" },
  ];
  const skillsText = Object.fromEntries(
    SKILLS.map((file) => [file.path, file.text])
  );

  test("a single-user run has the skills on disk before the first message", async () => {
    const run = setup({ script: toolRunScript(), skills: { files: SKILLS } });
    await run.execution.finished;
    expect(run.firstMessage.skills).toEqual(skillsText);
    expect(run.lines).toContain(
      `run ${run.claim.run.id}: skills synced: 4 files`
    );
    expect(doneBody(run).status).toBe("done");
  });

  test("leftover skills in the work directory are gone when the run starts", async () => {
    const claim = claimWith();
    const workDir = workDirOf(claim);
    mkdirSync(join(workDir, ".claude", "skills", "old"), { recursive: true });
    writeFileSync(join(workDir, ".claude", "skills", "old", "SKILL.md"), "old");
    const run = setup({
      claim,
      script: toolRunScript(),
      skills: { files: SKILLS },
    });
    await run.execution.finished;
    expect(run.firstMessage.skills).toEqual(skillsText);
    expect(existsSync(join(workDir, ".claude", "skills", "old"))).toBe(false);
  });

  test("a multi-user run writes each skill file through sudo dd with its text on stdin", async () => {
    const claim = claimWith();
    const skillsDir = `${remoteWorkDirOf(claim)}/.claude/skills`;
    const run = setup({
      claim,
      script: toolRunScript(),
      singleUser: false,
      skills: { files: SKILLS },
    });
    await run.execution.finished;
    expect(run.runCommands).toContainEqual([
      ...AS_AGENT,
      AGENT_DD,
      `of=${skillsDir}/a/SKILL.md`,
      "status=none",
    ]);
    expect(run.remoteFiles.get(`${skillsDir}/a/SKILL.md`)).toBe("# a");
    expect(run.remoteFiles.get(`${skillsDir}/b/helper.sh`)).toBe("echo b");
    expect(doneBody(run).status).toBe("done");
  });

  test("a failed list logs a warning, the run still completes, and no skills directory is made", async () => {
    const claim = claimWith();
    const run = setup({
      claim,
      script: toolRunScript(),
      skills: { files: SKILLS, listFails: 500 },
    });
    await run.execution.finished;
    expect(run.lines.join("\n")).toContain("skills sync failed");
    expect(run.firstMessage.skills).toBeUndefined();
    expect(existsSync(join(workDirOf(claim), ".claude"))).toBe(false);
    expect(doneBody(run).status).toBe("done");
  });

  test("a path with '..' is refused: nothing is written, the warning is logged, the run still completes", async () => {
    const claim = claimWith();
    const run = setup({
      claim,
      script: toolRunScript(),
      skills: {
        files: [
          { path: "a/SKILL.md", text: "# a" },
          { path: "a/../../evil/SKILL.md", text: "evil" },
        ],
      },
    });
    await run.execution.finished;
    expect(run.lines.join("\n")).toContain("skills sync failed");
    expect(run.firstMessage.skills).toBeUndefined();
    expect(existsSync(join(workDirOf(claim), ".claude"))).toBe(false);
    expect(doneBody(run).status).toBe("done");
  });

  test('buildOptions is unchanged: settingSources stays ["project"]', async () => {
    const run = setup({ script: toolRunScript(), skills: { files: SKILLS } });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.settingSources).toEqual(["project"]);
  });
});

describe("the agent's secrets", () => {
  const OPENAI = "fake-openai-value-0001";
  const RELAY = "fake-relay-token-0002";
  const MY_KEY = "fake-my-key-value-0003";
  const secretsClaim = () =>
    claimWith((c) => {
      c.env = {
        HARBOURMASTER_RELAY_TOKEN: RELAY,
        MY_API_KEY: MY_KEY,
        OPENAI_API_KEY: OPENAI,
      };
    });

  test("are in the env given to query, and a name that DENY_PATTERN matches survives", async () => {
    const run = setup({ claim: secretsClaim(), script: toolRunScript() });
    await run.execution.finished;
    const env = run.optionsSeen[0]?.env ?? {};
    expect(env.OPENAI_API_KEY).toBe(OPENAI);
    expect(env.HARBOURMASTER_RELAY_TOKEN).toBe(RELAY);
    expect(env.MY_API_KEY).toBe(MY_KEY);
    expect(env.HOME).toBe("/home/dom");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("the spawner is told the names to preserve", async () => {
    const run = setup({ claim: secretsClaim(), script: toolRunScript() });
    await run.execution.finished;
    expect(run.preserveEnvSeen).toEqual([
      ["HARBOURMASTER_RELAY_TOKEN", "MY_API_KEY", "OPENAI_API_KEY"],
    ]);
  });

  test("a claim without env keeps the filtered env and passes no names", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    expect(run.optionsSeen[0]?.env).toEqual({
      HOME: "/home/dom",
      PATH: "/usr/bin",
    });
    expect(run.preserveEnvSeen).toEqual([[]]);
    expect(doneBody(run).status).toBe("done");
  });

  test("a secret value sent to the relay, in an event or the completion, is masked by name", async () => {
    const [first, ...rest] = toolRun;
    const result = {
      ...(rest.at(-1) as object),
      result: `the key is ${OPENAI}`,
    } as unknown as SDKMessage;
    const assistant = {
      message: {
        content: [{ text: `echo ${OPENAI}`, type: "text" }],
        id: "msg_secret",
        model: "claude-haiku-5-5",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
      },
      parent_tool_use_id: null,
      session_id: (first as { session_id: string }).session_id,
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000000aa",
    } as unknown as SDKMessage;
    const sent: string[] = [];
    const wireFetch = Object.assign(
      (_input: Request | URL | string, request?: RequestInit) => {
        sent.push(typeof request?.body === "string" ? request.body : "");
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      { preconnect: () => undefined }
    );
    const run = setup({
      claim: secretsClaim(),
      script: [first as SDKMessage, assistant, TICK, result],
      wireFetch,
    });
    await run.execution.finished;
    const body = sent.join("\n");
    expect(body).toContain("[secret:OPENAI_API_KEY]");
    expect(body).not.toContain(OPENAI);
    expect(body).not.toContain(RELAY);
    expect(run.lines.join("\n")).not.toContain(OPENAI);
    expect(run.lines.join("\n")).not.toContain(RELAY);
  });
});

describe("the library copy", () => {
  const NOTES = "agents/ada/notes.md";

  const claimWithLibrary = (conflicts: string[] = []) =>
    claimWith((claim) => {
      claim.library = { conflicts, paths: ["agents/ada"] };
    });

  const promptOf = (options: Options | undefined): string => {
    const prompt = options?.systemPrompt;
    return typeof prompt === "object" && prompt !== null && "append" in prompt
      ? (prompt.append ?? "")
      : "";
  };

  const localFile = (workDir: string, path: string) =>
    join(workDir, "library", path);

  /** The script of a run that works for a while: a checkpoint after the first message. */
  const scriptWithCheckpoint = (): Step[] => {
    const [first, ...rest] = toolRunScript();
    return first === undefined ? [] : [first, CHECKPOINT, ...rest];
  };

  test("copies the named folders into library/ before the first message and says so in the prompt", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    remote.put("docs/other.md", "o");
    let seen: string | undefined;
    const run = setup({
      claim: claimWithLibrary(),
      library: {
        agent: (dir) => {
          seen = readFileSync(localFile(dir, NOTES), "utf8");
        },
        remote,
      },
      script: toolRunScript(),
    });
    await run.execution.finished;
    const workDir = workDirOf(run.claim);

    expect(seen).toBe("n1");
    expect(existsSync(join(workDir, "library", "docs"))).toBe(false);
    // The manifest sits beside library/, not inside it.
    expect(existsSync(join(workDir, "library.manifest.json"))).toBe(true);
    expect(promptOf(run.optionsSeen[0])).toContain(
      `- Library: ${workDir}/library holds a synced copy of agents/ada`
    );
  });

  test("the prompt lists the conflict copies the claim carries", async () => {
    const copy = "agents/ada/notes.md.conflict-r0";
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    remote.put(copy, "old");
    const run = setup({
      claim: claimWithLibrary([copy]),
      library: { remote },
      script: toolRunScript(),
    });
    await run.execution.finished;

    expect(promptOf(run.optionsSeen[0])).toContain(
      `delete the copy: ${workDirOf(run.claim)}/library/${copy}.`
    );
  });

  test("a claim with no library paths leaves the work directory and the prompt as before", async () => {
    const run = setup({ script: toolRunScript() });
    await run.execution.finished;
    const workDir = workDirOf(run.claim);

    expect(existsSync(join(workDir, "library"))).toBe(false);
    expect(existsSync(join(workDir, "library.manifest.json"))).toBe(false);
    expect(promptOf(run.optionsSeen[0])).not.toContain("synced copy");
  });

  test("the agent's changes go back after the process exited and before the completion", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      library: {
        agent: (workDir) => {
          writeFileSync(localFile(workDir, NOTES), "n2");
          writeFileSync(localFile(workDir, "agents/ada/new.md"), "new");
        },
        remote,
      },
      script: toolRunScript(),
    });
    await run.execution.finished;

    expect(new TextDecoder().decode(remote.files.get(NOTES)?.bytes)).toBe("n2");
    expect(
      new TextDecoder().decode(remote.files.get("agents/ada/new.md")?.bytes)
    ).toBe("new");
    const writes = run.order.filter((entry) =>
      entry.startsWith("library-write:")
    );
    expect(writes).toEqual([
      "library-write:agents/ada/new.md:exited=true",
      `library-write:${NOTES}:exited=true`,
    ]);
    const lastWrite = run.order.lastIndexOf(writes.at(-1) ?? "");
    expect(lastWrite).toBeLessThan(run.order.indexOf("complete:done"));
  });

  test("a checkpoint sends the changes while the process still runs, and the timer stops with the run", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      library: {
        agent: (workDir) => {
          writeFileSync(localFile(workDir, NOTES), "n2");
        },
        remote,
      },
      script: scriptWithCheckpoint(),
    });
    expect(run.timers.has("library-checkpoint")).toBe(false);
    await run.execution.finished;

    expect(run.order).toContain(`library-write:${NOTES}:exited=false`);
    expect(run.timers.has("library-checkpoint")).toBe(false);
    expect(new TextDecoder().decode(remote.files.get(NOTES)?.bytes)).toBe("n2");
  });

  test("a change a person made meanwhile leaves a conflict copy, and the run reports it", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      library: {
        agent: (workDir, memory) => {
          writeFileSync(localFile(workDir, NOTES), "mine");
          memory.put(NOTES, "theirs");
        },
        remote,
      },
      script: toolRunScript(),
    });
    await run.execution.finished;
    const copy = `${NOTES}.conflict-${run.claim.run.id}`;

    expect(new TextDecoder().decode(remote.files.get(NOTES)?.bytes)).toBe(
      "theirs"
    );
    expect(new TextDecoder().decode(remote.files.get(copy)?.bytes)).toBe(
      "mine"
    );
    expect(run.recordedConflicts).toEqual([
      { conflictPath: copy, path: NOTES },
    ]);
  });

  test("an aborted run sends nothing back", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      hang: true,
      library: {
        agent: (workDir) => {
          writeFileSync(localFile(workDir, NOTES), "n2");
        },
        remote,
      },
      script: [INIT],
    });
    await until(() =>
      run.order.some((entry) => entry.startsWith("first-message:"))
    );
    run.execution.abort("cancelled");
    await run.execution.finished;

    expect(run.order.some((entry) => entry.startsWith("library-write:"))).toBe(
      false
    );
    expect(new TextDecoder().decode(remote.files.get(NOTES)?.bytes)).toBe("n1");
    expect(run.completions[0]?.body).toEqual({ status: "aborted" });
  });

  test("a library that cannot be reached is a warning: the run goes ahead and the prompt names no copy", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      library: { down: true, remote },
      script: toolRunScript(),
    });
    await run.execution.finished;

    expect(doneBody(run).status).toBe("done");
    expect(promptOf(run.optionsSeen[0])).not.toContain("synced copy");
    expect(run.lines.join("\n")).toContain(
      "warning: syncing the library in failed"
    );
    expect(run.timers.has("library-checkpoint")).toBe(false);
  });

  test("a failed sync in means no sync out at the end either", async () => {
    const remote = createMemoryRemote();
    remote.put(NOTES, "n1");
    const run = setup({
      claim: claimWithLibrary(),
      library: { down: true, remote },
      script: toolRunScript(),
    });
    await run.execution.finished;

    expect(run.lines.filter((line) => line.includes("library synced"))).toEqual(
      []
    );
    expect(
      run.lines.filter((line) => line.includes("syncing the library"))
    ).toHaveLength(1);
  });
});
