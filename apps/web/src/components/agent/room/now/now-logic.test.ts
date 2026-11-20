import { expect, test } from "bun:test";
import {
  makeEvent,
  makeListItem,
  makeTask,
  NOW_MS,
  YESTERDAY_ISO,
} from "./now-fixtures.ts";
import {
  activeRun,
  latestStep,
  liveHelpers,
  MADE_TODAY_RUNS,
  runsSignature,
  stepText,
  todaysRuns,
} from "./now-logic.ts";

test("the active run is the newest one that can still change", () => {
  const tasks = [
    makeListItem({ id: "run_3", status: "done" }),
    makeListItem({ id: "run_2", status: "waiting" }),
    makeListItem({ id: "run_1", status: "running" }),
  ];
  expect(activeRun(tasks)?.id).toBe("run_2");
  expect(activeRun([makeListItem({ status: "failed" })])).toBeNull();
  expect(activeRun([])).toBeNull();
});

test("a helper that started after its parent is not the active run", () => {
  const tasks = [
    makeListItem({ helper: true, id: "run_2", status: "running" }),
    makeListItem({ id: "run_1", status: "running" }),
  ];
  expect(activeRun(tasks)?.id).toBe("run_1");
  expect(activeRun([tasks[0] as (typeof tasks)[number]])).toBeNull();
});

test("today's runs leave out yesterday's and stop at the cap", () => {
  const many = Array.from({ length: MADE_TODAY_RUNS + 3 }, (_, index) =>
    makeListItem({ id: `run_${String(index)}` })
  );
  expect(todaysRuns(many, NOW_MS)).toHaveLength(MADE_TODAY_RUNS);
  const mixed = [
    makeListItem({ id: "today" }),
    makeListItem({ createdAt: YESTERDAY_ISO, id: "yesterday" }),
  ];
  expect(todaysRuns(mixed, NOW_MS).map((run) => run.id)).toEqual(["today"]);
});

test("the signature changes when a run changes status", () => {
  const before = runsSignature([makeListItem({ status: "running" })]);
  const after = runsSignature([makeListItem({ status: "done" })]);
  expect(before).not.toBe(after);
});

test("the latest step is the last step of the receipt", () => {
  const step = latestStep(makeTask());
  expect(step?.state).toBe("running");
  expect(step?.title).toBe("Search invoices");
  expect(step?.index).toBe(2);
});

test("a result fills the step's detail and settles it", () => {
  const task = makeTask();
  task.events.push(
    makeEvent({
      id: "e03",
      payload: { ok: true, output: "3 invoices", toolUseId: "t1" },
      type: "tool.result",
    })
  );
  const step = latestStep(task);
  expect(step?.state).toBe("done");
  expect(step === null ? "" : stepText(step)).toBe(
    "Search invoices: 3 invoices"
  );
});

test("a run with no events has the trigger step only", () => {
  const step = latestStep(makeTask({ events: [] }));
  expect(step?.index).toBe(1);
});

test("events of other runs in the session do not count", () => {
  const task = makeTask();
  task.events.push(
    makeEvent({
      id: "e09",
      payload: { text: "Elsewhere" },
      runId: "run_other",
      type: "message.assistant",
    })
  );
  expect(latestStep(task)?.title).toBe("Search invoices");
});

test("only the subagents still working are helpers", () => {
  expect(liveHelpers(makeTask()).map((helper) => helper.id)).toEqual([
    "run_2",
    "run_3",
  ]);
  expect(liveHelpers(makeTask({ subagents: undefined }))).toEqual([]);
});
