/**
 * The fallback report for an investigator run that ended without reporting.
 * When the run failed, was cancelled, was interrupted, or finished without a
 * `report.ts` call that went through, this posts one
 * `investigation.result` event with outcome "escalate" to control-plane, so
 * the incident goes to a person. The incident id comes from the run's input
 * text (control-plane's request id is its approval id, not the incident), and
 * the ingest token from the workspace's proxy secret.
 */
import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import { redactText } from "./events/scrub.ts";
import type { EventRecord } from "./events.ts";
import type { SecretsService } from "./secrets.ts";

/** The proxy secret that marks an agent as an investigator. */
export const INGEST_TOKEN_SECRET = "CONTROL_PLANE_INGEST_TOKEN";
export const INGEST_PATH = "/ingest/events";

const AGENT_ID = "harbourmaster-investigator";
const TRIGGER_REQUEST_PREFIX = "trigger:";
const INCIDENT_IN_TEXT = /\binc_[0-9A-HJKMNP-TV-Z]{26}\b/;
/** A slow control-plane must not hold the write that ended the run. */
const POST_TIMEOUT_MS = 5000;
const SUMMARY_MAX = 200;
const PAYLOAD_SUMMARY_MAX = 2000;
const STEP_MAX = 500;
const NO_RESULT_STEP = "The run ended without reporting a result.";
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const SPACE_CHAR = /\s/u;
const WHITESPACE_RUN = /\s+/gu;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

type EndStatus = "failed" | "cancelled" | "interrupted" | "done";

/** What a run was started with: the trigger's request id and the prompt text. */
export interface RunRequest {
  inputText: string;
  requestId: string | null;
}

/**
 * The incident id (`inc_` and 26 characters) in the prompt of a run that a
 * trigger started, or null. The request id only tells that a trigger started
 * the run: control-plane sets it to its approval id.
 */
export const incidentIdOf = (run: RunRequest | null): string | null =>
  run?.requestId?.startsWith(TRIGGER_REQUEST_PREFIX)
    ? (run.inputText.match(INCIDENT_IN_TEXT)?.[0] ?? null)
    : null;

const withoutLoneSurrogates = (text: string): string =>
  text.replace(LONE_SURROGATE, "");

/** control-plane's payload limits count UTF-16 units. A pair cut in half loses its orphan half. */
const firstUnits = (text: string, max: number): string =>
  withoutLoneSurrogates(text.slice(0, max));

/** control-plane's envelope summary limit counts code points. */
const firstCodePoints = (text: string, max: number): string =>
  Array.from(text).slice(0, max).join("");

/** One line: control and format characters dropped, whitespace runs collapsed, trimmed. */
const oneLine = (text: string): string =>
  withoutLoneSurrogates(text)
    .replace(CONTROL_OR_FORMAT, (char) => (SPACE_CHAR.test(char) ? " " : ""))
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
  const sentence =
    status === "done"
      ? "The investigator run finished before it reported."
      : `The investigator run ended ${status} before it reported.`;
  const text = firstUnits(
    error === null ? sentence : `${sentence} Error: ${error}`,
    PAYLOAD_SUMMARY_MAX
  );
  const steps = [NO_RESULT_STEP];
  if (error !== null) {
    steps.push(firstUnits(`Error: ${error}`, STEP_MAX));
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
    case "run.finished":
      return "done";
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
  /** True when the run already posted its result: `report.ts` printed its success line. */
  reported: (
    workspaceId: string,
    runId: string,
    incidentId: string
  ) => Promise<boolean>;
  requestOf: (workspaceId: string, runId: string) => Promise<RunRequest | null>;
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
    const incidentId = incidentIdOf(await deps.requestOf(workspaceId, runId));
    if (incidentId === null) {
      return;
    }
    // A run that failed, was cancelled or was interrupted may have reported
    // first, and the second result is ignored. A run that finished is only
    // covered when it did not report, so that it posts one result in all.
    if (
      status === "done" &&
      (await deps.reported(workspaceId, runId, incidentId))
    ) {
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
        ? redactText(resolved.masker.mask(raw))
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
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
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

/** Reads the request id and prompt of a run, scoped to its workspace. */
export const createRunRequestReader =
  (db: Database) =>
  async (workspaceId: string, runId: string): Promise<RunRequest | null> => {
    const [row] = await db
      .select({ inputText: runs.inputText, requestId: runs.requestId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    return row ?? null;
  };

/**
 * Whether a run's own `report.ts` succeeded. The script prints
 * `reported <outcome> for <incident>: <answer>` only after control-plane
 * accepted the post, and the run's `tool.result` events keep that line.
 */
export const createReportedReader =
  (db: Database) =>
  async (
    workspaceId: string,
    runId: string,
    incidentId: string
  ): Promise<boolean> => {
    const rows = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.runId, runId),
          eq(events.workspaceId, workspaceId),
          eq(events.type, "tool.result")
        )
      );
    const line = new RegExp(
      `^reported (?:fixed|escalate) for ${incidentId}: `,
      "mu"
    );
    return rows.some(({ payload }) => {
      const parsed: unknown = payload === null ? null : JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null) {
        return false;
      }
      const { ok, output } = parsed as { ok?: unknown; output?: unknown };
      return ok === true && typeof output === "string" && line.test(output);
    });
  };
