import { expect, test } from "bun:test";
import type { BandTone, ReceiptStepState, RunStatus } from "@repo/db/shared";
import type { RequestView } from "#/components/requests/request-card-logic.ts";
import type { TaskView } from "#/integrations/trpc/types";
import {
  canStop,
  chipText,
  costText,
  countText,
  kindLabel,
  logTagClass,
  pendingTakeover,
  receiptRunOf,
  runsOnText,
  splitOtherRuns,
  statusPill,
  stepTime,
  stepTone,
} from "./task-logic.ts";

test("a step's tone follows its state", () => {
  const tones: Record<ReceiptStepState, BandTone> = {
    done: "ok",
    failed: "error",
    paused: "waiting",
    running: "running",
  };
  for (const state of Object.keys(tones) as ReceiptStepState[]) {
    expect(stepTone(state)).toBe(tones[state]);
  }
});

test("a chip reads as key: value", () => {
  expect(chipText({ key: "to", value: "accounts@acme.com" })).toBe(
    "to: accounts@acme.com"
  );
});

test("a count reads singular for one and plural otherwise", () => {
  expect(countText({ n: 23, noun: "emails" })).toBe("23 emails");
  expect(countText({ n: 1, noun: "calls" })).toBe("1 call");
  expect(countText({ n: 0, noun: "calls" })).toBe("0 calls");
  expect(countText({ n: 1, noun: "news" })).toBe("1 new");
});

test("a step's time is its first event's, or null", () => {
  const events = [
    { createdAt: "2026-10-26T08:01:00.000Z", id: "e1" },
    { createdAt: "2026-10-26T08:02:00.000Z", id: "e2" },
  ];
  expect(stepTime({ eventIds: ["e2", "e1"] }, events)).toBe(
    "2026-10-26T08:02:00.000Z"
  );
  expect(stepTime({ eventIds: [] }, events)).toBeNull();
  expect(stepTime({ eventIds: ["gone"] }, events)).toBeNull();
});

test("every step kind has a label", () => {
  expect(kindLabel("approval")).toBe("Approval");
  expect(kindLabel("trigger")).toBe("Trigger");
});

test("a waiting run reads as paused and needing the person", () => {
  expect(statusPill("waiting")).toEqual({
    text: "Paused, needs you",
    tone: "waiting",
  });
  expect(statusPill("failed").tone).toBe("error");
  expect(statusPill("done").tone).toBe("ok");
});

test("only a run that has not ended can be stopped", () => {
  const stoppable: RunStatus[] = ["queued", "offered", "running", "waiting"];
  for (const status of stoppable) {
    expect(canStop(status)).toBe(true);
  }
  for (const status of [
    "done",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    expect(canStop(status)).toBe(false);
  }
});

test("a cost reads in dollars, with a floor and a gap", () => {
  expect(costText(0.18)).toBe("$0.18");
  expect(costText(0)).toBe("$0.00");
  expect(costText(0.004)).toBe("<$0.01");
  expect(costText(null)).toBe("not reported");
});

test("an agent runs on its machine, else its runtime", () => {
  const agent = (machine: { id: string; name: string } | null) =>
    ({ id: "a", machine, name: "A", runtime: "cloud" }) as TaskView["agent"];
  expect(runsOnText(agent({ id: "m", name: "Dom's laptop" }))).toBe(
    "Dom's laptop"
  );
  expect(runsOnText(agent(null))).toBe("Cloud");
});

test("the receipt's run carries the handoff parent and the live status", () => {
  const task = {
    run: { inputText: "Pay the bills" },
    startedBy: {
      kind: "handoff",
      label: "Handoff from Inbox Triage",
      parentRunId: "run_0",
    },
  } as TaskView;
  expect(receiptRunOf(task, "waiting")).toMatchObject({
    inputText: "Pay the bills",
    parentAgentName: "Inbox Triage",
    parentRunId: "run_0",
    status: "waiting",
  });
  const plain = {
    run: { inputText: "Hi" },
    startedBy: { kind: "person", label: "Dom" },
  } as TaskView;
  expect(receiptRunOf(plain, "done")).toMatchObject({
    parentAgentName: undefined,
    parentRunId: null,
  });
});

test("the session's other runs split around this run's id", () => {
  const run = (id: string) => ({
    createdAt: "",
    id,
    inputText: id,
    status: "done" as const,
  });
  const { earlier, later } = splitOtherRuns(
    [run("run_1"), run("run_3")],
    "run_2"
  );
  expect(earlier.map(({ id }) => id)).toEqual(["run_1"]);
  expect(later.map(({ id }) => id)).toEqual(["run_3"]);
});

test("every log kind has its own tag colour", () => {
  const kinds = [
    "thought",
    "tool_call",
    "tool_result",
    "note",
    "error",
  ] as const;
  expect(new Set(kinds.map(logTagClass)).size).toBe(kinds.length);
});

test("the pending takeover is the run's open request of that kind", () => {
  const takeover = (id: string, settled: RequestView["settled"]) =>
    [
      id,
      {
        anchorId: null,
        display: { machineId: "m1", reason: `Reason ${id}` },
        expiresAt: "",
        id,
        kind: "takeover",
        runId: "run_1",
        settled,
      },
    ] as const;
  const question = [
    "q1",
    {
      anchorId: null,
      display: { questions: [] },
      expiresAt: "",
      id: "q1",
      kind: "question",
      runId: "run_1",
      settled: null,
    },
  ] as unknown as readonly [string, RequestView];
  expect(pendingTakeover(new Map([question]))).toBeNull();
  expect(
    pendingTakeover(new Map([takeover("t1", { status: "expired" })]))
  ).toBeNull();
  expect(
    pendingTakeover(
      new Map([takeover("t1", { status: "expired" }), takeover("t2", null)])
    )
  ).toEqual({ reason: "Reason t2", requestId: "t2" });
});
