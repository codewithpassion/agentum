// The pure helpers behind the task view (V2.11): the words and tones of a
// receipt step, the facts row, and the receipt's inputs built from `tasks.get`.

import type {
  ActionLogKind,
  AgentRuntime,
  BandTone,
  KeyChip,
  ReceiptStep,
  ReceiptStepKind,
  ReceiptStepState,
  RunStatus,
} from "@repo/db/shared";
import type { ReceiptRun } from "@repo/services/tasks/receipt";
import type { TaskView } from "#/integrations/trpc/types";

const STEP_TONES: Record<ReceiptStepState, BandTone> = {
  done: "ok",
  failed: "error",
  paused: "waiting",
  running: "running",
};

/** The tone of a receipt step, in the colours the desk's status bands use. */
export const stepTone = (state: ReceiptStepState): BandTone =>
  STEP_TONES[state];

const KIND_LABELS: Record<ReceiptStepKind, string> = {
  approval: "Approval",
  error: "Error",
  message: "Message",
  question: "Question",
  result: "Result",
  skill: "Skill",
  tool: "Tool",
  trigger: "Trigger",
};

export const kindLabel = (kind: ReceiptStepKind): string => KIND_LABELS[kind];

/** One key and value as plain text, for a chip's tooltip. */
export const chipText = (chip: KeyChip): string => `${chip.key}: ${chip.value}`;

/** "23 emails", or "1 email" for a count of one. */
export const countText = (count: { n: number; noun: string }): string => {
  const noun =
    count.n === 1 && count.noun.endsWith("s")
      ? count.noun.slice(0, -1)
      : count.noun;
  return `${count.n} ${noun}`;
};

/** The time of a step: when its first event was stored, or null when it has none. */
export const stepTime = (
  step: Pick<ReceiptStep, "eventIds">,
  events: readonly { createdAt: string; id: string }[]
): string | null => {
  const [first] = step.eventIds;
  return events.find((event) => event.id === first)?.createdAt ?? null;
};

/** The status pill of a task: its words and tone. */
export const statusPill = (
  status: RunStatus
): { text: string; tone: BandTone } => {
  switch (status) {
    case "queued":
    case "offered":
      return { text: "Waiting to start", tone: "waiting" };
    case "running":
      return { text: "Running", tone: "running" };
    case "waiting":
      return { text: "Paused, needs you", tone: "waiting" };
    case "done":
      return { text: "Done", tone: "ok" };
    case "failed":
      return { text: "Failed", tone: "error" };
    case "interrupted":
      return { text: "Interrupted", tone: "error" };
    case "cancelled":
      return { text: "Cancelled", tone: "ok" };
    default:
      return { text: status, tone: "running" };
  }
};

const STOPPABLE: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];

/** True while `runs.cancel` accepts the run. */
export const canStop = (status: RunStatus): boolean =>
  STOPPABLE.includes(status);

const CENTS = 100;

/** "$0.18", "<$0.01" for a tiny cost, or "not reported" when the runtime gave none. */
export const costText = (costUsd: number | null): string => {
  if (costUsd === null) {
    return "not reported";
  }
  if (costUsd > 0 && costUsd < 1 / CENTS) {
    return "<$0.01";
  }
  return `$${costUsd.toFixed(2)}`;
};

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  cloud: "Cloud",
  fake: "Fake runtime",
  machine: "A machine",
  managed: "Managed agent",
};

/** Where the agent runs: its machine by name, else its runtime. */
export const runsOnText = (agent: TaskView["agent"]): string =>
  agent.machine?.name || RUNTIME_LABELS[agent.runtime];

const HANDOFF_PREFIX = "Handoff from ";

/** What `buildReceipt` reads of the run, from the fields `tasks.get` carries. */
export const receiptRunOf = (
  task: TaskView,
  status: RunStatus
): ReceiptRun => ({
  inputText: task.run.inputText,
  parentAgentName:
    task.startedBy.kind === "handoff"
      ? task.startedBy.label.replace(HANDOFF_PREFIX, "")
      : undefined,
  parentRunId: task.startedBy.parentRunId ?? null,
  // Only a fallback for a missing `run.queued` event, which the stream carries.
  reply: { kind: "none" },
  status,
});

/** The session's other runs, split by the run id order that follows time. */
export const splitOtherRuns = (
  otherRuns: TaskView["otherRuns"],
  runId: string
): { earlier: TaskView["otherRuns"]; later: TaskView["otherRuns"] } => ({
  earlier: otherRuns.filter((run) => run.id < runId),
  later: otherRuns.filter((run) => run.id > runId),
});

const TAG_CLASSES: Record<ActionLogKind, string> = {
  error: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  note: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  thought: "bg-muted text-muted-foreground",
  tool_call:
    "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100",
  tool_result:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
};

/** The Tailwind classes of an action log kind tag. */
export const logTagClass = (kind: ActionLogKind): string => TAG_CLASSES[kind];

const PILL_CLASSES: Record<BandTone, string> = {
  error: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  running: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  waiting: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
};

/** The Tailwind classes of a status pill of the given tone. */
export const pillClass = (tone: BandTone): string => PILL_CLASSES[tone];
