import type { ReceiptStep } from "@repo/db/shared";
import type { EventRecord } from "../events.ts";
import type { RunRecord } from "../runs/types.ts";
import {
  chips,
  object,
  parseOutput,
  payloadOf,
  requestDetail,
  text,
  toolWords,
} from "./format.ts";

// Parent names are supplied by the caller because events only carry parentRunId.
export type ReceiptRun = Pick<
  RunRecord,
  "inputText" | "parentRunId" | "status" | "reply"
> & { parentAgentName?: string };
interface ToolGroup {
  arrays: number | null;
  calls: number;
  name: string;
  noun: string;
  remaining: number;
  step: ReceiptStep;
}
interface ReceiptContext {
  active: ToolGroup | undefined;
  calls: Map<string, ToolGroup>;
  groups: ToolGroup[];
  requests: Map<string, ReceiptStep>;
  steps: ReceiptStep[];
}
const ORIGINS: Record<string, string> = {
  inbox: "Inbox",
  mcp: "MCP",
  routine: "Routine",
  slack: "Slack",
  trigger: "Trigger",
  ui: "UI",
};

const addStep = (
  ctx: ReceiptContext,
  kind: ReceiptStep["kind"],
  title: string,
  detail: string,
  state: ReceiptStep["state"] = "done"
): ReceiptStep => {
  const step: ReceiptStep = {
    countToNext: null,
    detail,
    eventIds: [],
    in: [],
    index: ctx.steps.length + 1,
    kind,
    out: [],
    state,
    title,
  };
  ctx.steps.push(step);
  return step;
};

const addOrigin = (
  ctx: ReceiptContext,
  run: ReceiptRun,
  events: readonly EventRecord[]
) => {
  const queued = events.find((event) => event.type === "run.queued");
  // Missing origin events default to UI, with Slack reply metadata as a useful fallback.
  const origin =
    text(queued && payloadOf(queued).origin) ||
    (run.reply.kind === "slack" ? "slack" : "ui");
  const title = run.parentRunId
    ? `Handoff from ${text(run.parentAgentName) || "another run"}`
    : `From ${ORIGINS[origin] ?? toolWords(origin)}`;
  const first = addStep(ctx, "trigger", title, text(run.inputText));
  if (queued) {
    first.eventIds.push(queued.id);
  }
  for (const event of events) {
    if (event.type === "message.user") {
      first.eventIds.push(event.id);
    }
  }
};

const addCall = (ctx: ReceiptContext, event: EventRecord) => {
  const payload = payloadOf(event);
  const name = text(payload.name);
  const skill = name === "activate_skill" || name === "Skill";
  let group = ctx.active;
  if (!group || group.name !== name || skill) {
    const skillName =
      text(object(payload.input)[name === "Skill" ? "skill" : "name"]) ||
      "Unknown skill";
    group = {
      arrays: null,
      calls: 0,
      name,
      noun: "items",
      remaining: 0,
      step: addStep(
        ctx,
        skill ? "skill" : "tool",
        skill ? `Skill: ${skillName}` : toolWords(name),
        "",
        "running"
      ),
    };
    ctx.groups.push(group);
  }
  group.calls += 1;
  group.remaining += 1;
  group.step.eventIds.push(event.id);
  // Folded chips summarize the latest call/result; counts cover the whole group.
  group.step.in = chips(payload.input);
  if (group.step.state !== "failed") {
    group.step.state = "running";
  }
  if (group.calls > 1) {
    group.step.title = `${toolWords(name)} ×${group.calls}`;
  }
  const id = text(payload.toolUseId);
  if (id) {
    ctx.calls.set(id, group);
  }
  ctx.active = skill ? undefined : group;
};

const countArrays = (group: ToolGroup, output: unknown) => {
  // Sum lengths across results in a folded group; multiple array keys use "items".
  const arrays = Array.isArray(output)
    ? [["items", output] as const]
    : Object.entries(object(output)).filter(
        (entry): entry is [string, unknown[]] => Array.isArray(entry[1])
      );
  if (arrays.length === 0) {
    return;
  }
  group.arrays =
    (group.arrays ?? 0) + arrays.reduce((n, [, items]) => n + items.length, 0);
  group.noun = arrays.length === 1 ? text(arrays[0]?.[0]) : "items";
};

const addResult = (ctx: ReceiptContext, event: EventRecord) => {
  const payload = payloadOf(event);
  const id = text(payload.toolUseId);
  const group = ctx.calls.get(id);
  if (!group) {
    return;
  }
  ctx.calls.delete(id);
  group.remaining -= 1;
  const { step } = group;
  step.eventIds.push(event.id);
  step.detail = text(payload.output);
  const output = parseOutput(payload.output);
  step.out = chips(output);
  countArrays(group, output);
  if (payload.ok === false) {
    step.state = "failed";
  } else if (step.state !== "failed") {
    step.state = group.remaining === 0 ? "done" : "running";
  }
};

const addRequest = (ctx: ReceiptContext, event: EventRecord) => {
  ctx.active = undefined;
  const payload = payloadOf(event);
  const requestId = text(payload.requestId);
  if (event.type !== "request.opened") {
    const step = ctx.requests.get(requestId);
    if (step) {
      step.state = event.type === "request.answered" ? "done" : "failed";
      step.eventIds.push(event.id);
    }
    return;
  }
  const kind = payload.kind === "question" ? "question" : "approval";
  const step = addStep(
    ctx,
    kind,
    kind === "question" ? "Question" : "Approval required",
    requestDetail(payload.display),
    "paused"
  );
  step.eventIds.push(event.id);
  if (requestId) {
    step.requestId = requestId;
    ctx.requests.set(requestId, step);
  }
};

const addEvent = (ctx: ReceiptContext, event: EventRecord) => {
  switch (event.type) {
    case "tool.call":
      addCall(ctx, event);
      break;
    case "tool.result":
      addResult(ctx, event);
      break;
    case "message.assistant":
      ctx.active = undefined;
      addStep(
        ctx,
        "message",
        "Assistant",
        text(payloadOf(event).text)
      ).eventIds.push(event.id);
      break;
    case "run.failed":
      ctx.active = undefined;
      addStep(
        ctx,
        "error",
        "Run failed",
        text(payloadOf(event).error),
        "failed"
      ).eventIds.push(event.id);
      break;
    default:
      if (event.type.startsWith("request.")) {
        addRequest(ctx, event);
      }
  }
};

/** Events are supplied in stream order. Results join their calls even when tools overlap. */
export const buildReceipt = (
  run: ReceiptRun,
  events: readonly EventRecord[]
): ReceiptStep[] => {
  const ctx: ReceiptContext = {
    active: undefined,
    calls: new Map(),
    groups: [],
    requests: new Map(),
    steps: [],
  };
  addOrigin(ctx, run, events);
  for (const event of events) {
    addEvent(ctx, event);
  }
  for (const group of ctx.groups) {
    if (
      group.remaining > 0 &&
      ["failed", "interrupted", "cancelled"].includes(run.status)
    ) {
      group.step.state = "failed";
    }
    // A finished run has no open calls. A result whose body went to R2 has no
    // toolUseId to join on, so settle the step instead of leaving it running.
    if (
      group.remaining > 0 &&
      run.status === "done" &&
      group.step.state !== "failed"
    ) {
      group.step.state = "done";
    }
    if (group.step !== ctx.steps.at(-1)) {
      group.step.countToNext = {
        n: group.arrays ?? group.calls,
        noun: group.arrays === null ? "calls" : group.noun,
      };
    }
  }
  return ctx.steps;
};
