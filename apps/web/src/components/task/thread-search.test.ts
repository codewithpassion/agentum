import { expect, test } from "bun:test";
import { threadOfTask, threadSearchSchema } from "./thread-search.ts";

const task = (runId: string) => ({
  otherRuns: [{ id: "run-1" }, { id: "run-3" }].filter(
    (run) => run.id !== runId
  ),
  run: { id: runId },
  session: { id: "ses-1" },
});

test("an old run URL goes to its thread with that run in view", () => {
  expect(threadOfTask(task("run-1"), undefined)).toEqual({
    params: { sessionId: "ses-1" },
    search: { run: "run-1" },
  });
});

test("the latest run's URL goes to the bare thread, keeping the tab", () => {
  expect(threadOfTask(task("run-3"), "files")).toEqual({
    params: { sessionId: "ses-1" },
    search: { tab: "files" },
  });
});

test("a bad run or tab in the URL reads as none", () => {
  expect(threadSearchSchema.parse({ run: "", tab: "nope" })).toEqual({
    run: undefined,
    tab: undefined,
  });
  expect(threadSearchSchema.parse({ run: "run-2", tab: "log" })).toEqual({
    run: "run-2",
    tab: "log",
  });
});
