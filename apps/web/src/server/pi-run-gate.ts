// Asks a person before a ruled tool runs, and lets the agent ask a question.
// Kept free of `cloudflare:workers` so bun can test it; `pi-run.ts` supplies the
// requests service and installs the extension.
//
// The gate is a `beforeTool` hook of Pi's tool task, not a wrapper around each
// tool. A tool task runs the hook before it records its intent, so a task cut
// short while the hook waits starts over from the hook after an eviction, with
// no replay policy involved: the hook finds its request again by the tool call
// id and waits again, or goes on at once when the request is closed. Once the
// hook lets the call through, the tool runs under its own replay policy, so a
// call that finished is never run twice and an unsafe one is never rerun. A
// wrapper could not do this: it would need the tool's replay policy for the
// run and a safe one for the wait, and a tool has only one. A hook also covers
// the MCP tools installed later, which a wrap by name cannot.
//
// A wait ends in one of three ways: `answered(requestId)` (the RPC from the
// platform after an answer, an expiry or a cancel), `checkOpen()` (the lease
// beat, in case the RPC was missed or went to an object that has since been
// evicted), or the call's abort. Each wake reads the request again, so a wake
// that is spurious or early costs one read.
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type HookApi,
  hook,
  type ToolHookCall,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  ASK_USER_TOOL,
  outcomeText,
  type Question,
  questionSchema,
  type RequestOutcome,
  toolKey,
} from "@repo/protocol/requests";
import type { ToolOrigin } from "./pi-run-mcp.ts";

/** The extension's name in the registry. */
export const GATE_EXTENSION = "hm-request-gate";

/** How long a rule lookup is trusted. An answer that sets a rule clears it at once. */
export const RULE_CACHE_MS = 30_000;

const ASK_USER_SECTION = "ask-user";
const ASK_USER_PROMPT =
  "Use the ask_user tool when you cannot go on without a person's answer, such as a choice only they can make; it can wait for hours, so try everything else first and ask one clear question.";

/** A request a run opens for a person. `toolUseId` is Pi's tool call id, so opening twice finds the first. */
export type OpenRequest =
  | {
      input: Record<string, unknown>;
      kind: "approval";
      runId: string;
      toolKey: string;
      toolName: string;
      toolUseId: string;
    }
  | {
      kind: "question";
      questions: Question[];
      runId: string;
      toolName: string;
      toolUseId: string;
    };

/** The requests service as the run itself uses it. `pi-run.ts` binds the system principal. */
export interface GateRequests {
  /** Whether the agent has an "ask" rule for the tool. */
  needsApproval: (input: {
    runId: string;
    toolKey: string;
  }) => Promise<boolean>;
  /** Opens the request, or returns the one already open for the tool call. */
  open: (
    input: OpenRequest
  ) => Promise<{ id: string; outcome: RequestOutcome | null }>;
  /** How a request ended, or null while it is pending. */
  outcome: (requestId: string) => Promise<RequestOutcome | null>;
}

export interface GateDeps {
  now?: () => number;
  /** The MCP server and tool a Pi tool name came from, or undefined for any other tool. */
  originOf: (piName: string) => ToolOrigin | undefined;
  requests: GateRequests;
  /** The run a tool call belongs to: the session's newest. */
  runIdOf: () => Promise<string>;
  /** The keys of the MCP servers whose tools are installed. */
  serverKeys: () => readonly string[];
}

/** Waits for a request to change, from any of the wakes above. */
const createWaiters = () => {
  const sleepers = new Map<string, Set<() => void>>();

  const watch = (requestId: string) => {
    let wake: () => void = () => undefined;
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const set = sleepers.get(requestId) ?? new Set();
    set.add(wake);
    sleepers.set(requestId, set);
    return {
      changed,
      stop: () => {
        set.delete(wake);
        if (set.size === 0 && sleepers.get(requestId) === set) {
          sleepers.delete(requestId);
        }
      },
    };
  };

  const wake = (requestId: string) => {
    for (const resolve of sleepers.get(requestId) ?? []) {
      resolve();
    }
  };

  const wakeAll = () => {
    for (const requestId of [...sleepers.keys()]) {
      wake(requestId);
    }
  };

  return { wake, wakeAll, watch };
};

export const createGate = ({
  now = Date.now,
  originOf,
  requests,
  runIdOf,
  serverKeys,
}: GateDeps) => {
  const waiters = createWaiters();
  /** Rule lookups by run and tool key, so a call with no rule costs no read after the first. */
  const rules = new Map<string, { at: number; ruled: boolean }>();

  /** How the tool is named in rules. An MCP tool carries the server and name it was listed with. */
  const keyOf = (call: ToolHookCall): string => {
    const origin = originOf(call.name);
    if (origin) {
      return toolKey({
        name: origin.name,
        runtime: "cloud",
        server: origin.server,
      });
    }
    return toolKey({
      name: call.name,
      runtime: "cloud",
      serverKeys: serverKeys(),
    });
  };

  const isRuled = async (runId: string, key: string): Promise<boolean> => {
    const id = `${runId}\u0000${key}`;
    const known = rules.get(id);
    if (known && now() - known.at < RULE_CACHE_MS) {
      return known.ruled;
    }
    const ruled = await requests.needsApproval({ runId, toolKey: key });
    rules.set(id, { at: now(), ruled });
    return ruled;
  };

  /** Waits until the request is closed. Rejects when the call is aborted. */
  const outcomeOf = async (
    request: { id: string; outcome: RequestOutcome | null },
    context: Context
  ): Promise<RequestOutcome> => {
    if (request.outcome) {
      return request.outcome;
    }
    for (;;) {
      // Watching before the read, so a wake between the read and the wait is not lost.
      const watching = waiters.watch(request.id);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each pass follows a wake
        const outcome = await requests.outcome(request.id);
        if (outcome) {
          return outcome;
        }
        await awaitWithContext(watching.changed, context);
      } finally {
        watching.stop();
      }
    }
  };

  const beforeTool = async (
    call: ToolHookCall,
    _api: HookApi,
    context: Context
  ): Promise<{ block: string } | undefined> => {
    if (call.name === ASK_USER_TOOL.name) {
      return;
    }
    const key = keyOf(call);
    const runId = await runIdOf();
    if (!(await isRuled(runId, key))) {
      return;
    }
    const request = await requests.open({
      input: call.arguments,
      kind: "approval",
      runId,
      toolKey: key,
      toolName: key,
      toolUseId: call.id,
    });
    const text = outcomeText("approval", await outcomeOf(request, context));
    return text === null ? undefined : { block: text };
  };

  /** Replay safe: after an eviction it opens the same request again and waits again. */
  const askUser: ToolRegistration = {
    description: ASK_USER_TOOL.description,
    execute: async (args, api, context) => {
      const question = questionSchema.parse(args);
      const request = await requests.open({
        kind: "question",
        questions: [question],
        runId: await runIdOf(),
        toolName: ASK_USER_TOOL.name,
        toolUseId: api.callId,
      });
      const outcome = await outcomeOf(request, context);
      return {
        isError: outcome.status !== "answered",
        output: [
          { text: outcomeText("question", outcome) ?? "", type: "text" },
        ],
      };
    },
    name: ASK_USER_TOOL.name,
    // Type.Unsafe passes the JSON schema through unchanged.
    parameters: Type.Unsafe(ASK_USER_TOOL.inputSchema),
    replay: "safe",
  };

  return {
    /** A request was closed: wakes its waiter, and drops the rule lookups because an answer can set a rule. */
    answered: (requestId: string) => {
      rules.clear();
      waiters.wake(requestId);
    },
    askUser,
    beforeTool,
    /** Makes every waiting call read its request again, and drops the rule lookups. The lease beat calls it. */
    checkOpen: () => {
      // An answer found here may have set a rule, and the map should not grow for ever.
      rules.clear();
      waiters.wakeAll();
    },
  };
};

export type Gate = ReturnType<typeof createGate>;

/** The hook that gates ruled tools, the `ask_user` tool and the sentence that tells the model when to use it. */
export const gateExtension = (gate: Gate) =>
  defineExtension({
    hooks: [hook(ToolTask, { beforeTool: gate.beforeTool })],
    name: GATE_EXTENSION,
    sections: [{ key: ASK_USER_SECTION, render: () => ASK_USER_PROMPT }],
    tools: [gate.askUser],
  });
