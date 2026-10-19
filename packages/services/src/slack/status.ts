/**
 * The Slack thread status while a run works: "is thinking…", then the label
 * of the tool it runs. `createSlackStatus` decides when Slack gets a call, and
 * `createDbStatusPorts` finds the thread and the bot token for each call.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import type { EventRecord } from "../events.ts";
import { type Clock, replyTargetSchema } from "../runs/types.ts";
import { createSecretReader, findInstalledApp } from "./apps.ts";
import {
  createSlackClient,
  type SlackCallResult,
  type SlackFetch,
} from "./client.ts";
import { describeFailure } from "./post.ts";

export const THINKING_STATUS = "is thinking…";
/** At most one status update per run in this many ms. */
export const STATUS_MIN_INTERVAL_MS = 5000;

const CLEAR_STATUS = "";
/** Slack refuses the status in some kinds of conversation. Those runs skip it quietly. */
const CHANNEL_NOT_SUPPORTED = "method_not_supported_for_channel_type";
const MAX_TRACKED_RUNS = 500;
const DEFAULT_TOOL_STATUS = "is working…";
/** An MCP tool name is `mcp__<server>__<tool>`. Only the tool part matters here. */
const TOOL_NAME_SEPARATOR = "__";
const SLACK_TOOL_PREFIX = "slack";
const SLACK_TOOL_STATUS = "is searching Slack…";
/** No update was sent yet, so the first one is never held back. */
const NEVER_SENT = Number.NEGATIVE_INFINITY;

const TOOL_GROUPS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["read", "glob", "grep", "ls", "find"], "is reading files…"],
  [
    ["write", "edit", "multiedit", "notebookedit", "apply_patch"],
    "is editing files…",
  ],
  [["bash", "run_skill_script"], "is running a command…"],
  [
    ["websearch", "web_search", "webfetch", "web_fetch"],
    "is searching the web…",
  ],
];

const TOOL_LABELS: ReadonlyMap<string, string> = new Map(
  TOOL_GROUPS.flatMap(([names, label]) =>
    names.map((name): [string, string] => [name, label])
  )
);

/** The event types that change the status. Any other type is ignored. */
const TRACKED_TYPES: ReadonlySet<string> = new Set([
  "tool.call",
  "run.started",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "run.finished",
  "slack.delivered",
]);

/** The Slack thread a run replies in, plus what is needed to find the bot token. */
export interface StatusTarget {
  agentId: string;
  channel: string;
  teamId: string;
  threadTs: string;
  workspaceId: string;
}

export interface StatusPorts {
  /** Calls assistant.threads.setStatus with the agent's bot token. May throw (no token). */
  send: (target: StatusTarget, status: string) => Promise<SlackCallResult>;
  /** The Slack thread the run of this event replies in, or null when the run does not reply in Slack. */
  targetOf: (event: EventRecord) => Promise<StatusTarget | null>;
}

interface RunState {
  ended: boolean;
  label: string;
  lastAt: number;
  stopped: boolean;
  target: StatusTarget | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The status for a tool, from its name such as "mcp__harbourmaster__slack_search". */
export const toolStatus = (toolName: string): string => {
  const cut = toolName.lastIndexOf(TOOL_NAME_SEPARATOR);
  const name = (
    cut === -1 ? toolName : toolName.slice(cut + TOOL_NAME_SEPARATOR.length)
  ).toLowerCase();
  if (name.startsWith(SLACK_TOOL_PREFIX)) {
    return SLACK_TOOL_STATUS;
  }
  return TOOL_LABELS.get(name) ?? DEFAULT_TOOL_STATUS;
};

export const createSlackStatus = ({
  clock,
  defer,
  ports,
}: {
  clock: Clock;
  defer?: (work: Promise<void>) => void;
  ports: StatusPorts;
}) => {
  const states = new Map<string, RunState>();

  const remember = (runId: string, state: RunState): void => {
    if (!states.has(runId) && states.size >= MAX_TRACKED_RUNS) {
      const [oldest] = states.keys();
      if (oldest !== undefined) {
        states.delete(oldest);
      }
    }
    states.set(runId, state);
  };

  /** Sends one status. A failure stops the run's later sends and logs once. */
  const deliver = async (
    state: RunState,
    target: StatusTarget,
    status: string
  ): Promise<void> => {
    try {
      const result = await ports.send(target, status);
      if (result.kind === "ok") {
        return;
      }
      state.stopped = true;
      const code = describeFailure(result);
      if (code !== CHANNEL_NOT_SUPPORTED) {
        console.warn(`Slack status not set: ${code}`);
      }
    } catch (error) {
      state.stopped = true;
      console.warn(`Slack status not set: ${messageOf(error)}`);
    }
  };

  /** Hands the work to `defer` when given, so the request that appended the event does not wait. */
  const dispatch = (work: Promise<void>): Promise<void> => {
    if (defer) {
      defer(work);
      return Promise.resolve();
    }
    return work;
  };

  /** The work for a label change, or null when the rate limit or the state says no. */
  const update = (state: RunState, label: string): Promise<void> | null => {
    const { target } = state;
    if (!target || state.stopped || state.ended || label === state.label) {
      return null;
    }
    const now = clock.now().getTime();
    if (now - state.lastAt < STATUS_MIN_INTERVAL_MS) {
      return null;
    }
    state.lastAt = now;
    state.label = label;
    return deliver(state, target, label);
  };

  /** Ends the run. A clear sends an empty status when the run has a target that still works. */
  const finish = (
    runId: string,
    state: RunState,
    clear: boolean
  ): Promise<void> | null => {
    state.ended = true;
    states.delete(runId);
    if (!(clear && state.target) || state.stopped) {
      return null;
    }
    return deliver(state, state.target, CLEAR_STATUS);
  };

  const react = (
    runId: string,
    state: RunState,
    event: EventRecord
  ): Promise<void> | null => {
    switch (event.type) {
      case "tool.call": {
        const name =
          typeof event.payload.name === "string" ? event.payload.name : "";
        return update(state, toolStatus(name));
      }
      case "run.started":
        return update(state, THINKING_STATUS);
      case "run.failed":
      case "run.cancelled":
      case "run.interrupted":
        return finish(runId, state, true);
      case "slack.delivered":
        return finish(runId, state, event.payload.delivered === false);
      case "run.finished":
        // The reply post clears the status, so the state stays until slack.delivered.
        state.ended = true;
        if (!state.target) {
          states.delete(runId);
        }
        return null;
      default:
        return null;
    }
  };

  /** The state of a run. On first sight it asks `targetOf` once and keeps the answer, a null target too. */
  const stateFor = async (
    runId: string,
    event: EventRecord
  ): Promise<RunState> => {
    const known = states.get(runId);
    if (known) {
      return known;
    }
    let target: StatusTarget | null = null;
    try {
      target = await ports.targetOf(event);
    } catch (error) {
      console.warn(`Slack status not set: ${messageOf(error)}`);
    }
    // A concurrent event for the same run may have stored its state meanwhile.
    const raced = states.get(runId);
    if (raced) {
      return raced;
    }
    const state: RunState = {
      ended: false,
      label: "",
      lastAt: NEVER_SENT,
      stopped: false,
      target,
    };
    remember(runId, state);
    return state;
  };

  /** Shows "is thinking…" when a run begins. Awaits the one send. */
  const begin = async (runId: string, target: StatusTarget): Promise<void> => {
    const state: RunState = {
      ended: false,
      label: THINKING_STATUS,
      lastAt: clock.now().getTime(),
      stopped: false,
      target,
    };
    remember(runId, state);
    await deliver(state, target, THINKING_STATUS);
  };

  const onEvent = async (event: EventRecord): Promise<void> => {
    const { runId } = event;
    if (runId === null || !TRACKED_TYPES.has(event.type)) {
      return;
    }
    const state = await stateFor(runId, event);
    const work = react(runId, state, event);
    if (work) {
      await dispatch(work);
    }
  };

  return { begin, onEvent };
};

export type SlackStatus = ReturnType<typeof createSlackStatus>;

/** The status ports for the app: the thread from the `runs` row, the token from the installed app. */
export const createDbStatusPorts = ({
  db,
  fetch,
  secretsKey,
}: {
  db: Database;
  fetch: SlackFetch;
  secretsKey?: string;
}): StatusPorts => {
  const secrets = createSecretReader(secretsKey);
  return {
    send: async (target, status) => {
      const app = await findInstalledApp(db, {
        agentId: target.agentId,
        teamId: target.teamId,
        workspaceId: target.workspaceId,
      });
      const token = app ? await secrets.botToken(app) : null;
      if (!token) {
        throw new Error("The agent has no installed Slack app for this team");
      }
      return createSlackClient({ fetch, token }).setStatus({
        channel: target.channel,
        status,
        threadTs: target.threadTs,
      });
    },
    targetOf: async (event) => {
      if (event.runId === null) {
        return null;
      }
      const [run] = await db
        .select({ agentId: runs.agentId, reply: runs.reply })
        .from(runs)
        .where(
          and(eq(runs.id, event.runId), eq(runs.workspaceId, event.workspaceId))
        )
        .limit(1);
      if (!run || run.reply === null) {
        return null;
      }
      const reply = replyTargetSchema.safeParse(JSON.parse(run.reply));
      if (!reply.success || reply.data.kind !== "slack") {
        return null;
      }
      return {
        agentId: run.agentId,
        channel: reply.data.channel,
        teamId: reply.data.teamId,
        threadTs: reply.data.threadTs,
        workspaceId: event.workspaceId,
      };
    },
  };
};
