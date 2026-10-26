export const INCIDENT_ID = /^inc_[0-9A-HJKMNP-TV-Z]{26}$/;

const SUMMARY_MAX = 2000;
const STEPS_MAX = 50;
const STEP_MAX = 500;
const EVENT_SUMMARY_MAX = 200;
const RESPONSE_TEXT_MAX = 200;
const TRAILING_SLASHES = /\/+$/;

export type Outcome = "fixed" | "escalate";

export interface ReportInput {
  incidentId: string;
  outcome: Outcome;
  steps: string[];
  summary: string;
}

export type ParseResult =
  | { ok: true; input: ReportInput }
  | { ok: false; error: string };

export interface StepInput {
  incidentId: string;
  text: string;
}

export type ParseStepResult =
  | { ok: true; input: StepInput }
  | { ok: false; error: string };

export interface ReportEvent {
  actor: { kind: "agent"; id: "harbourmaster-investigator" };
  correlation_id: string;
  fingerprint: string;
  payload: {
    incidentId: string;
    runId: string;
    outcome: Outcome;
    summary: string;
    steps: string[];
  };
  severity: "info";
  source: "agent";
  summary: string;
  system_id: null;
  ts: string;
  type: "investigation.result";
}

export interface StepEvent {
  actor: { kind: "agent"; id: "harbourmaster-investigator" };
  correlation_id: string;
  fingerprint: string;
  payload: {
    incidentId: string;
    runId: string;
    text: string;
  };
  severity: "info";
  source: "agent";
  summary: string;
  system_id: null;
  ts: string;
  type: "investigation.step";
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type PostResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

function withoutLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "");
}

/** control-plane's string limits count UTF-16 code units, so cut by those. A pair cut in half loses its orphan. */
function cutUnits(text: string, max: number): string {
  return withoutLoneSurrogates(text.slice(0, max));
}

/** control-plane's envelope summary limit counts code points. */
function cutCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RecordResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

function parseRecord(raw: string | undefined, label: string): RecordResult {
  if (raw === undefined) {
    return { error: `no ${label} given`, ok: false };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: `${label} is not valid JSON`, ok: false };
  }

  if (!isRecord(data)) {
    return { error: `${label} must be a JSON object`, ok: false };
  }

  return { data, ok: true };
}

export function parseReportInput(raw: string | undefined): ParseResult {
  const parsed = parseRecord(raw, "report input");
  if (!parsed.ok) {
    return parsed;
  }

  const { incidentId, outcome, summary, steps } = parsed.data;

  if (typeof incidentId !== "string" || !INCIDENT_ID.test(incidentId)) {
    return {
      error: "incidentId must look like inc_ followed by 26 characters",
      ok: false,
    };
  }

  if (outcome !== "fixed" && outcome !== "escalate") {
    return { error: 'outcome must be "fixed" or "escalate"', ok: false };
  }

  if (typeof summary !== "string" || summary.trim() === "") {
    return { error: "summary must be a non-empty string", ok: false };
  }

  let cleanSteps: string[] = [];
  if (steps !== undefined) {
    if (
      !(Array.isArray(steps) && steps.every((step) => typeof step === "string"))
    ) {
      return { error: "steps must be an array of strings", ok: false };
    }
    cleanSteps = steps
      .slice(0, STEPS_MAX)
      .map((step) => cutUnits(step, STEP_MAX));
  }

  return {
    input: {
      incidentId,
      outcome,
      steps: cleanSteps,
      summary: cutUnits(summary, SUMMARY_MAX),
    },
    ok: true,
  };
}

export function parseStepInput(raw: string | undefined): ParseStepResult {
  const parsed = parseRecord(raw, "step input");
  if (!parsed.ok) {
    return parsed;
  }

  const { incidentId, text } = parsed.data;

  if (typeof incidentId !== "string" || !INCIDENT_ID.test(incidentId)) {
    return {
      error: "incidentId must look like inc_ followed by 26 characters",
      ok: false,
    };
  }

  if (typeof text !== "string" || text.trim() === "") {
    return { error: "text must be a non-empty string", ok: false };
  }

  const cut = cutUnits(text, STEP_MAX);
  if (cut.trim() === "") {
    return { error: "text must not be only whitespace", ok: false };
  }

  return { input: { incidentId, text: cut }, ok: true };
}

/** One line for the envelope summary: whitespace collapsed, no control or format characters, at most 200 code points. */
function oneLine(text: string): string {
  const line = withoutLoneSurrogates(text)
    .replace(/\s+/gu, " ")
    .replace(CONTROL_OR_FORMAT, "")
    .trim();
  return cutCodePoints(line, EVENT_SUMMARY_MAX).trim();
}

function eventSummary(text: string, fallback: string): string {
  const line = oneLine(text);
  return line === "" ? fallback : line;
}

export function buildEvent({
  input,
  now,
  runId,
}: {
  input: ReportInput;
  now: Date;
  runId: string;
}): ReportEvent {
  return {
    actor: { id: "harbourmaster-investigator", kind: "agent" },
    correlation_id: input.incidentId,
    fingerprint: `hm-investigator:${input.incidentId}`,
    payload: {
      incidentId: input.incidentId,
      outcome: input.outcome,
      runId,
      steps: input.steps,
      summary: input.summary,
    },
    severity: "info",
    source: "agent",
    summary: eventSummary(input.summary, `Investigation ${input.outcome}`),
    system_id: null,
    ts: now.toISOString(),
    type: "investigation.result",
  };
}

export function buildStepEvent({
  input,
  now,
  runId,
}: {
  input: StepInput;
  now: Date;
  runId: string;
}): StepEvent {
  return {
    actor: { id: "harbourmaster-investigator", kind: "agent" },
    correlation_id: input.incidentId,
    fingerprint: `hm-investigator:${input.incidentId}`,
    payload: {
      incidentId: input.incidentId,
      runId,
      text: input.text,
    },
    severity: "info",
    source: "agent",
    summary: eventSummary(input.text, "Investigation step"),
    system_id: null,
    ts: now.toISOString(),
    type: "investigation.step",
  };
}

export function ingestUrl(base: string | undefined): string | null {
  if (base === undefined || base === "") {
    return null;
  }
  return `${base.replace(TRAILING_SLASHES, "")}/ingest/events`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function postResult({
  event,
  fetchFn,
  url,
}: {
  event: ReportEvent | StepEvent;
  fetchFn: FetchFn;
  url: string;
}): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    return { message: `request failed: ${errorMessage(error)}`, ok: false };
  }

  if (response.ok) {
    return { message: `HTTP ${response.status}`, ok: true };
  }

  const text = await response.text().catch(() => "");
  const snippet = cutCodePoints(
    text.replace(/\s+/gu, " ").trim(),
    RESPONSE_TEXT_MAX
  );
  const detail = snippet === "" ? "" : `: ${snippet}`;
  return { message: `HTTP ${response.status}${detail}`, ok: false };
}
