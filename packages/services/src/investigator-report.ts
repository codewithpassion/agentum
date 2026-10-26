/**
 * The fallback report for an investigator run that ended without reporting.
 * When the run failed, was cancelled or was interrupted, this posts one
 * `investigation.result` event with outcome "escalate" to control-plane, so
 * the incident goes to a person. The incident id comes from the run's trigger
 * request id, and the ingest token from the workspace's proxy secret.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import type { EventRecord } from "./events.ts";
import type { SecretsService } from "./secrets.ts";

/** The proxy secret that marks an agent as an investigator. */
export const INGEST_TOKEN_SECRET = "CONTROL_PLANE_INGEST_TOKEN";
export const INGEST_PATH = "/ingest/events";

const AGENT_ID = "harbourmaster-investigator";
const TRIGGER_REQUEST_ID = /^trigger:[^:]+:(inc_[0-9A-HJKMNP-TV-Z]{26})$/;
const SUMMARY_MAX = 200;
const PAYLOAD_SUMMARY_MAX = 2000;
const STEP_MAX = 500;
const NO_RESULT_STEP = "The run ended without reporting a result.";
const CONTROL_CHAR = /\p{Cc}/gu;
const SPACE_CHAR = /\s/u;
const WHITESPACE_RUN = /\s+/gu;

type EndStatus = "failed" | "cancelled" | "interrupted";

/** The incident id of a trigger request id such as `trigger:<triggerId>:inc_...`, or null. */
export const incidentIdOf = (requestId: string | null): string | null =>
  requestId?.match(TRIGGER_REQUEST_ID)?.[1] ?? null;

/** Cuts text to `max` code points, so no surrogate pair is split. */
const firstCodePoints = (text: string, max: number): string =>
  Array.from(text).slice(0, max).join("");

/** One line: control characters dropped, whitespace runs collapsed, trimmed. */
const oneLine = (text: string): string =>
  text
    .replace(CONTROL_CHAR, (char) => (SPACE_CHAR.test(char) ? " " : ""))
    .replace(WHITESPACE_RUN, " ")
    .trim();

export const escalationEvent = ({
  error,
  incidentId,
  now,
  runId,
  status,
}: {
  error: string | null;
  incidentId: string;
  now: Date;
  runId: string;
  status: EndStatus;
}): Record<string, unknown> => {
  const sentence = `The investigator run ended ${status} before it reported.`;
  const text = firstCodePoints(
    error === null ? sentence : `${sentence} Error: ${error}`,
    PAYLOAD_SUMMARY_MAX
  );
  const steps = [NO_RESULT_STEP];
  if (error !== null) {
    steps.push(firstCodePoints(`Error: ${error}`, STEP_MAX));
  }
  return {
    actor: { id: AGENT_ID, kind: "agent" },
    correlation_id: incidentId,
    fingerprint: `hm-investigator:${incidentId}`,
    payload: {
      incidentId,
      outcome: "escalate",
      runId,
      steps,
      summary: text,
    },
    severity: "info",
    source: "agent",
    summary: firstCodePoints(oneLine(text), SUMMARY_MAX),
    system_id: null,
    ts: now.toISOString(),
    type: "investigation.result",
  };
};

const endStatusOf = (type: EventRecord["type"]): EndStatus | null => {
  switch (type) {
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "run.interrupted":
      return "interrupted";
    default:
      return null;
  }
};

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

export interface ReportBackDeps {
  defer?: (work: Promise<void>) => void;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  requestIdOf: (workspaceId: string, runId: string) => Promise<string | null>;
  secrets: Pick<SecretsService, "proxyFor" | "resolveForAgent">;
}

/** Never throws: a failed report must not fail the write that ended the run. */
export const createInvestigatorReportBack = (deps: ReportBackDeps) => {
  const { secrets } = deps;

  /** Posts the escalation for one ended run. Does nothing when the run is not an incident's or has no ingest token. */
  const post = async (
    event: EventRecord,
    runId: string,
    agentId: string,
    status: EndStatus
  ): Promise<void> => {
    const { workspaceId } = event;
    const incidentId = incidentIdOf(await deps.requestIdOf(workspaceId, runId));
    if (incidentId === null) {
      return;
    }
    const resolved = await secrets.resolveForAgent(workspaceId, agentId);
    const grant = resolved.proxy.find(
      (secret) => secret.name === INGEST_TOKEN_SECRET
    );
    const host = grant?.hosts.find((name) => !name.startsWith("*."));
    if (host === undefined) {
      return;
    }
    const match = (await secrets.proxyFor(workspaceId, agentId, host)).find(
      (rule) => rule.name === INGEST_TOKEN_SECRET
    );
    if (!match) {
      return;
    }
    const raw = event.payload.error;
    const error =
      typeof raw === "string" && raw.length > 0
        ? resolved.masker.mask(raw)
        : null;
    const response = await deps.fetch(`https://${host}${INGEST_PATH}`, {
      body: JSON.stringify(
        escalationEvent({
          error,
          incidentId,
          now: deps.now(),
          runId,
          status,
        })
      ),
      headers: {
        "Content-Type": "application/json",
        [match.header]: match.headerValue,
      },
      method: "POST",
    });
    if (!response.ok) {
      console.warn(
        `Investigator report for run ${runId} got HTTP ${response.status}`
      );
    }
  };

  const onEvent = async (event: EventRecord): Promise<void> => {
    const status = endStatusOf(event.type);
    const { agentId, runId } = event;
    if (status === null || runId === null || agentId === null) {
      return;
    }
    const report = async (): Promise<void> => {
      try {
        await post(event, runId, agentId, status);
      } catch (error) {
        console.warn(
          `Investigator report for run ${runId} not sent: ${nameOf(error)}`
        );
      }
    };
    if (deps.defer) {
      deps.defer(report());
      return;
    }
    await report();
  };

  return { onEvent };
};

/** Reads the request id of a run, scoped to its workspace. */
export const createRequestIdReader =
  (db: Database) =>
  async (workspaceId: string, runId: string): Promise<string | null> => {
    const [row] = await db
      .select({ requestId: runs.requestId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    return row?.requestId ?? null;
  };
