import type { ReceiptStep } from "@repo/db/shared";
import { buildReceipt } from "@repo/services/tasks/receipt";
import { receiptRunOf } from "#/components/task/task-logic.ts";
import { isActive } from "#/components/task/task-state.ts";
import type { RouterOutputs, TaskView } from "#/integrations/trpc/types";

/** A row of `tasks.list`: one run of the agent. */
export type TaskListItem = RouterOutputs["tasks"]["list"][number];

/** A subagent run of a task, as `tasks.get` lists it. */
export type Helper = NonNullable<TaskView["subagents"]>[number];

/** How many of today's runs the Made today card reads files and artifacts for. */
export const MADE_TODAY_RUNS = 20;

/** The latest step of a run, in the words of its receipt. */
export interface StepLine {
  detail: string;
  index: number;
  state: ReceiptStep["state"];
  title: string;
}

/** The newest task that can still change, or null. A helper is part of its parent's task, so it never counts. `tasks.list` returns newest first. */
export const activeRun = (
  tasks: readonly TaskListItem[]
): TaskListItem | null =>
  tasks.find((task) => !task.helper && isActive(task.status)) ?? null;

const startOfLocalDay = (ms: number): number => {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
};

/** The runs that started on the viewer's calendar day, newest first, at most `MADE_TODAY_RUNS`. */
export const todaysRuns = (
  tasks: readonly TaskListItem[],
  nowMs: number
): TaskListItem[] => {
  const dayStart = startOfLocalDay(nowMs);
  return tasks
    .filter((task) => Date.parse(task.createdAt) >= dayStart)
    .slice(0, MADE_TODAY_RUNS);
};

/** Changes when a run starts or changes status, so the Made today card reads again. */
export const runsSignature = (runs: readonly TaskListItem[]): string =>
  runs.map((run) => `${run.id}:${run.status}`).join(",");

/** The last step of the run's receipt, or null when the run has no events yet. */
export const latestStep = (task: TaskView): StepLine | null => {
  const events = task.events.filter((event) => event.runId === task.run.id);
  const step = buildReceipt(receiptRunOf(task, task.run.status), events).at(-1);
  return step === undefined
    ? null
    : {
        detail: step.detail,
        index: step.index,
        state: step.state,
        title: step.title,
      };
};

/** A step as one line: its title, then its detail when it has one. */
export const stepText = (step: Pick<StepLine, "detail" | "title">): string =>
  step.detail === "" ? step.title : `${step.title}: ${step.detail}`;

/** The task's subagents that are still working, oldest first. */
export const liveHelpers = (task: TaskView): Helper[] =>
  (task.subagents ?? []).filter((helper) => isActive(helper.status));
