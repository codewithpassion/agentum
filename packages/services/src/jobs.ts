import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { slackApps } from "@repo/db/schema/slack";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  isPendingProposal,
  type JobSentence,
  type JobSource,
  LIVE_RUN_STATUSES,
  type ProposedTrigger,
  type RunStatus,
  type TriggerKind,
} from "@repo/db/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize } from "./authz.ts";
import {
  requireOwnAgent,
  requireReader,
  requireWriter,
} from "./automation-access.ts";
import { invalid, notFound, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import { readableWorkspace } from "./guards.ts";
import type { JobDrafter } from "./job-drafting/draft.ts";
import { jobLineFor } from "./roster.ts";
import { nextFireTime } from "./routines/cron.ts";
import { cronToWords } from "./routines/cron-to-words.ts";
import type { Clock } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const JOBS_READ = "jobs.read";
const JOBS_WRITE = "jobs.write";
const JOBS_KIND = "jobs";

/** The longest description of a job the model reads. */
export const JOB_TEXT_MAX = 2000;

export const forAgentInputSchema = z.strictObject({
  agentId: z.string().min(1),
});

export const draftInputSchema = z.strictObject({
  agentId: z.string().min(1),
  text: z.string().trim().min(1).max(JOB_TEXT_MAX),
});

export const runNowInputSchema = z.strictObject({
  jobId: z.string().min(1),
});

const ASK_WORDS = {
  custom: "Following its custom instructions",
  everything: "Everything it does",
  outside: "Acting outside its workspace",
  rarely: null,
} as const;

const compareText = (a: string, b: string): number =>
  a < b ? -1 : Number(a > b);
const compareJobs = (a: JobSentence, b: JobSentence): number => {
  const agentOrder = compareText(a.agent.name, b.agent.name);
  if (agentOrder !== 0) {
    return agentOrder;
  }
  if (a.source === "routine" && b.source === "routine") {
    return (
      compareText(a.nextRunAt ?? "~", b.nextRunAt ?? "~") ||
      compareText(a.id, b.id)
    );
  }
  if (a.source === "routine" || b.source === "routine") {
    return a.source === "routine" ? -1 : 1;
  }
  return compareText(a.id, b.id);
};

type TriggerRow = typeof triggers.$inferSelect;

/** True for a finished good run, false for a finished bad one, null while the run is still live. */
const runEndedWell = (status: RunStatus): boolean | null => {
  if (LIVE_RUN_STATUSES.includes(status)) {
    return null;
  }
  return status === "done";
};

const nextRunFor = (
  trigger: TriggerRow,
  enabled: boolean,
  timezone: string,
  clock: Clock
): string | null => {
  if (!enabled || trigger.kind !== "routine") {
    return null;
  }
  if (trigger.nextRunAt !== null) {
    return trigger.nextRunAt;
  }
  const next = nextFireTime(trigger.cron ?? "", timezone, clock.now());
  return next === null ? null : new Date(next).toISOString();
};

const whenFor = (
  trigger: TriggerRow,
  timezone: string,
  workspaceTimezone: string,
  emailLocal: string | null,
  mailDomain?: string
): string => {
  switch (trigger.kind) {
    case "routine":
      return cronToWords(trigger.cron ?? "", timezone, workspaceTimezone);
    case "http":
      return "When its web address is called";
    case "mail":
      return emailLocal && mailDomain
        ? `When mail arrives at ${emailLocal}@${mailDomain}`
        : "When mail arrives";
    case "app":
      return "When its app asks for it";
    default:
      return "";
  }
};

interface TriggerJoinRow {
  trigger: { kind: TriggerKind };
}

const isJobRow = <Row extends TriggerJoinRow>(
  row: Row
): row is Row & { trigger: { kind: JobSource } } =>
  row.trigger.kind !== "dream";

export const createJobsService = ({
  db,
  clock,
  drafter,
  events,
  runs: runsService,
  mailDomain,
}: {
  db: Database;
  clock: Clock;
  drafter: JobDrafter;
  events: EventsService;
  runs: RunsService;
  mailDomain?: string;
}) => {
  const read = async (
    workspaceId: string,
    agentId?: string
  ): Promise<JobSentence[]> => {
    const triggerRows = await db
      .select({
        agent: agents,
        trigger: triggers,
        workspaceTimezone: workspaces.timezone,
      })
      .from(triggers)
      .innerJoin(
        agents,
        and(
          eq(agents.id, triggers.agentId),
          eq(agents.workspaceId, workspaceId)
        )
      )
      .innerJoin(workspaces, eq(workspaces.id, triggers.workspaceId))
      .where(
        and(
          eq(triggers.workspaceId, workspaceId),
          isNull(triggers.revokedAt),
          agentId === undefined ? undefined : eq(triggers.agentId, agentId)
        )
      );
    // The dream trigger is the system's, set from the agent's dream schedule.
    // It shows on the Knows tab, never as a job.
    const rows = triggerRows.filter(isJobRow);
    const sentences = await Promise.all(
      rows.map(
        async ({ trigger, agent, workspaceTimezone }): Promise<JobSentence> => {
          const enabled =
            trigger.disabledAt === null && !isPendingProposal(trigger);
          const [last] = await db
            .select({
              createdAt: runs.createdAt,
              startedAt: runs.startedAt,
              status: runs.status,
            })
            .from(runs)
            .where(
              and(
                eq(runs.workspaceId, workspaceId),
                eq(runs.agentId, agent.id),
                eq(runs.actorKind, "trigger"),
                eq(runs.actorId, trigger.id)
              )
            )
            .orderBy(desc(runs.id))
            .limit(1);
          const timezone = trigger.timezone ?? workspaceTimezone;
          const nextRunAt = nextRunFor(trigger, enabled, timezone, clock);
          const when = whenFor(
            trigger,
            timezone,
            workspaceTimezone,
            agent.emailLocal,
            mailDomain
          );
          return {
            agent: { id: agent.id, name: agent.name },
            asksBefore: ASK_WORDS[agent.askLevel],
            deliversTo: null,
            does:
              trigger.kind === "routine"
                ? ((trigger.prompt ?? "")
                    .split("\n")
                    .map((line) => line.trim())
                    .find(Boolean) ?? "")
                : jobLineFor(agent.instructions),
            enabled,
            id: trigger.id,
            // Queued runs have no startedAt yet; show when the start was requested.
            lastRunAt: last ? (last.startedAt ?? last.createdAt) : null,
            lastRunOk: last ? runEndedWell(last.status) : null,
            nextRunAt,
            source: trigger.kind,
            when,
          };
        }
      )
    );
    // Slack starts are attributed to the linked user, not the app. There is no
    // reliable actor-to-app link for history; installed is the active status.
    const slackRows = await db
      .select({
        agent: agents,
        id: slackApps.id,
        listenMode: slackApps.listenMode,
        status: slackApps.status,
      })
      .from(slackApps)
      .innerJoin(
        agents,
        and(
          eq(agents.id, slackApps.agentId),
          eq(agents.workspaceId, workspaceId)
        )
      )
      .where(
        and(
          eq(slackApps.workspaceId, workspaceId),
          agentId === undefined ? undefined : eq(slackApps.agentId, agentId)
        )
      );
    for (const row of slackRows) {
      sentences.push({
        agent: { id: row.agent.id, name: row.agent.name },
        asksBefore: ASK_WORDS[row.agent.askLevel],
        deliversTo: null,
        does: jobLineFor(row.agent.instructions),
        enabled: row.status === "installed",
        id: row.id,
        lastRunAt: null,
        lastRunOk: null,
        nextRunAt: null,
        source: "slack",
        when:
          row.listenMode === "mentions"
            ? "When mentioned in Slack"
            : "When a message arrives in Slack",
      });
    }
    return sentences.sort(compareJobs);
  };

  const forAgent = async (
    principal: Principal,
    agentId: string
  ): Promise<JobSentence[]> => {
    const reader = requireReader(principal, JOBS_READ);
    requireOwnAgent(reader, agentId, JOBS_READ);
    const workspaceId = readableWorkspace(principal, JOBS_READ);
    authorize(principal, JOBS_READ, {
      id: agentId,
      kind: JOBS_KIND,
      workspaceId,
    });
    return await read(workspaceId, agentId);
  };

  const list = async (principal: Principal): Promise<JobSentence[]> => {
    const reader = requireReader(principal, JOBS_READ);
    const workspaceId = readableWorkspace(principal, JOBS_READ);
    authorize(principal, JOBS_READ, { kind: JOBS_KIND, workspaceId });
    // A run sees only its own agent's jobs.
    return await read(
      workspaceId,
      reader.kind === "run" ? reader.agentId : undefined
    );
  };

  const draft = (
    principal: Principal,
    agentId: string,
    text: string
  ): Promise<ProposedTrigger> => {
    const workspaceId = readableWorkspace(principal, JOBS_WRITE);
    requireWriter(principal, JOBS_WRITE);
    authorize(principal, JOBS_WRITE, {
      id: agentId,
      kind: JOBS_KIND,
      workspaceId,
    });
    return drafter.draft(principal, agentId, text);
  };

  const runNow = async (
    principal: Principal,
    jobId: string
  ): Promise<{ runId: string }> => {
    const workspaceId = readableWorkspace(principal, JOBS_WRITE);
    const writer = requireWriter(principal, JOBS_WRITE);
    authorize(principal, JOBS_WRITE, {
      id: jobId,
      kind: JOBS_KIND,
      workspaceId,
    });
    const [row] = await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.id, jobId), eq(triggers.workspaceId, workspaceId)))
      .limit(1);
    if (!row) {
      throw notFound("Job not found");
    }
    requireOwnAgent(writer, row.agentId, JOBS_WRITE);
    if (row.kind !== "routine") {
      throw invalid("Only routines can run now");
    }
    if (row.revokedAt !== null || isPendingProposal(row)) {
      throw new ServiceError(
        "conflict",
        "Routine is revoked or awaiting approval"
      );
    }
    // A paused, approved routine can run once without resuming its schedule.
    const requestId = `trigger:${row.id}:now:${ulid()}`;
    const started = await runsService.startRun(
      {
        agentId: row.agentId,
        kind: "trigger",
        triggerId: row.id,
        workspaceId,
      },
      {
        agentId: row.agentId,
        input: { text: row.prompt ?? "" },
        requestId,
        session: { origin: "trigger" },
      }
    );
    await events.append({
      actor: { id: row.id, kind: "trigger" },
      agentId: row.agentId,
      payload: { requestId, triggerId: row.id },
      runId: started.runId,
      sessionId: started.sessionId,
      type: "trigger.fired",
      workspaceId,
    });
    return { runId: started.runId };
  };

  return { draft, forAgent, list, runNow };
};

export type JobsService = ReturnType<typeof createJobsService>;
