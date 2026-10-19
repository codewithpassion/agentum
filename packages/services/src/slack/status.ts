/**
 * The Slack thread status while a run works: "is thinking…", then the label
 * of the tool it runs. `createSlackStatus` turns run events into status calls,
 * and `createDbStatusPorts` keeps the facts it needs on the `runs` row: when a
 * status was last claimed, which label, and whether the run's status has
 * stopped. The facts live in the database, not in memory, because every
 * request builds its own services and a run's events arrive in many requests.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
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
const DEFAULT_TOOL_STATUS = "is working…";
/** An MCP tool name is `mcp__<server>__<tool>`. Only the tool part matters here. */
const TOOL_NAME_SEPARATOR = "__";
const SLACK_TOOL_PREFIX = "slack";
const SLACK_TOOL_STATUS = "is searching Slack…";

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

/** The Slack thread a run replies in, plus what is needed to find the bot token. */
export interface StatusTarget {
  agentId: string;
  channel: string;
  teamId: string;
  threadTs: string;
  workspaceId: string;
}

/** What `claim` asks for: the right to show `label` on a run now. */
export interface StatusClaim {
  /** A status claimed at or before this ISO time may be replaced. */
  cutoff: string;
  label: string;
  /** The ISO time to record as the claim time. */
  now: string;
  runId: string;
  workspaceId: string;
}

export interface StatusPorts {
  /**
   * Takes the right to show `label` on a run, in one conditional write so it
   * holds across requests. Gives the Slack thread when this call won: the run
   * replies in Slack, its status has not stopped, the last claim is older than
   * `cutoff` and shows another label. Gives null in every other case.
   */
  claim: (claim: StatusClaim) => Promise<StatusTarget | null>;
  /**
   * Stops all later status for a run. Gives the Slack thread when this call
   * stopped it, null when the run does not reply in Slack or already stopped.
   */
  finish: (runId: string, workspaceId: string) => Promise<StatusTarget | null>;
  /** Calls assistant.threads.setStatus with the agent's bot token. May throw (no token). */
  send: (target: StatusTarget, status: string) => Promise<SlackCallResult>;
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

/** The Slack call that follows a won claim, not started until it is called. */
type Job = () => Promise<void>;

export const createSlackStatus = ({
  clock,
  defer,
  ports,
}: {
  clock: Clock;
  defer?: (work: Promise<void>) => void;
  ports: StatusPorts;
}) => {
  /** Sends one status. Gives the failure code, or null when Slack took it. */
  const trySend = async (
    target: StatusTarget,
    status: string
  ): Promise<string | null> => {
    try {
      const result = await ports.send(target, status);
      return result.kind === "ok" ? null : describeFailure(result);
    } catch (error) {
      return messageOf(error);
    }
  };

  const warn = (code: string): void => {
    if (code !== CHANNEL_NOT_SUPPORTED) {
      console.warn(`Slack status not set: ${code}`);
    }
  };

  /**
   * Sends a claimed status. A failure stops the run's status for good, in the
   * database, and only the call that stopped it logs, so a run warns once even
   * when many requests fail on the same missing scope.
   */
  const show = async (
    runId: string,
    target: StatusTarget,
    status: string
  ): Promise<void> => {
    const failure = await trySend(target, status);
    if (failure === null) {
      return;
    }
    try {
      if (await ports.finish(runId, target.workspaceId)) {
        warn(failure);
      }
    } catch (error) {
      console.warn(`Slack status not stopped: ${messageOf(error)}`);
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

  /** Claims `label` and, when this call won the claim, returns the job that shows it. */
  const update = async (
    runId: string,
    workspaceId: string,
    label: string
  ): Promise<Job | null> => {
    const now = clock.now();
    const target = await ports.claim({
      cutoff: new Date(now.getTime() - STATUS_MIN_INTERVAL_MS).toISOString(),
      label,
      now: now.toISOString(),
      runId,
      workspaceId,
    });
    return target ? () => show(runId, target, label) : null;
  };

  /** Stops the run's status and clears what is shown. Does nothing when it already stopped. */
  const end = async (
    runId: string,
    workspaceId: string
  ): Promise<Job | null> => {
    const target = await ports.finish(runId, workspaceId);
    if (!target) {
      return null;
    }
    return async () => {
      const failure = await trySend(target, CLEAR_STATUS);
      if (failure !== null) {
        warn(failure);
      }
    };
  };

  const react = (
    runId: string,
    event: EventRecord
  ): Promise<Job | null> | null => {
    const { workspaceId } = event;
    switch (event.type) {
      case "tool.call": {
        const name =
          typeof event.payload.name === "string" ? event.payload.name : "";
        return update(runId, workspaceId, toolStatus(name));
      }
      case "run.started":
        return update(runId, workspaceId, THINKING_STATUS);
      case "run.failed":
      case "run.cancelled":
      case "run.interrupted":
        return end(runId, workspaceId);
      case "slack.delivered":
        // A posted reply clears the status by itself. Only a failed post leaves it up.
        return event.payload.delivered === false
          ? end(runId, workspaceId)
          : null;
      default:
        return null;
    }
  };

  /** Shows "is thinking…" when a run starts from Slack. Awaits the one send. */
  const begin = async (runId: string, workspaceId: string): Promise<void> => {
    try {
      await (await update(runId, workspaceId, THINKING_STATUS))?.();
    } catch (error) {
      console.warn(`Slack status not set: ${messageOf(error)}`);
    }
  };

  /** Never throws: a status problem must not fail the write that triggered it. */
  const onEvent = async (event: EventRecord): Promise<void> => {
    const { runId } = event;
    if (runId === null) {
      return;
    }
    try {
      const job = await react(runId, event);
      if (job) {
        await dispatch(job());
      }
    } catch (error) {
      console.warn(`Slack status not set: ${messageOf(error)}`);
    }
  };

  return { begin, onEvent };
};

export type SlackStatus = ReturnType<typeof createSlackStatus>;

/** The thread of a run row that replies in Slack, or null for any other reply. */
const targetOf = (
  row: { agentId: string; reply: string | null },
  workspaceId: string
): StatusTarget | null => {
  if (row.reply === null) {
    return null;
  }
  const reply = replyTargetSchema.safeParse(JSON.parse(row.reply));
  if (!reply.success || reply.data.kind !== "slack") {
    return null;
  }
  return {
    agentId: row.agentId,
    channel: reply.data.channel,
    teamId: reply.data.teamId,
    threadTs: reply.data.threadTs,
    workspaceId,
  };
};

/** True for a run whose answer goes to a Slack thread. */
const repliesInSlack = sql`json_extract(${runs.reply}, '$.kind') = 'slack'`;

/** The status ports for the app: the facts on the `runs` row, the token from the installed app. */
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
    claim: async (claim) => {
      const [row] = await db
        .update(runs)
        .set({ slackStatusAt: claim.now, slackStatusLabel: claim.label })
        .where(
          and(
            eq(runs.id, claim.runId),
            eq(runs.workspaceId, claim.workspaceId),
            eq(runs.slackStatusStopped, false),
            repliesInSlack,
            or(
              isNull(runs.slackStatusAt),
              lte(runs.slackStatusAt, claim.cutoff)
            ),
            or(
              isNull(runs.slackStatusLabel),
              ne(runs.slackStatusLabel, claim.label)
            )
          )
        )
        .returning({ agentId: runs.agentId, reply: runs.reply });
      return row ? targetOf(row, claim.workspaceId) : null;
    },
    finish: async (runId, workspaceId) => {
      const [row] = await db
        .update(runs)
        .set({ slackStatusStopped: true })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.workspaceId, workspaceId),
            eq(runs.slackStatusStopped, false),
            repliesInSlack
          )
        )
        .returning({ agentId: runs.agentId, reply: runs.reply });
      return row ? targetOf(row, workspaceId) : null;
    },
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
  };
};
