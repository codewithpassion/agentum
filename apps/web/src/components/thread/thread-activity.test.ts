import { expect, test } from "bun:test";
import { threadActivity, waitingMessages } from "./thread-activity.ts";

const event = (runId: string | null, type: string) => ({ runId, type });

test("a started run works and a queued one waits behind it", () => {
  const activity = threadActivity([
    event("r1", "run.queued"),
    event("r1", "run.started"),
    event("r2", "run.queued"),
  ]);
  expect(activity.working).toBe("r1");
  expect(activity.queued).toEqual(["r2"]);
});

test("a run that ended no longer works, and the queued run that started takes over", () => {
  const activity = threadActivity([
    event("r1", "run.queued"),
    event("r1", "run.started"),
    event("r2", "run.queued"),
    event("r1", "run.finished"),
    event("r2", "run.started"),
  ]);
  expect(activity).toMatchObject({ queued: [], working: "r2" });
});

test("a run cancelled before it started is removed, one cancelled after is not", () => {
  const activity = threadActivity([
    event("r1", "run.queued"),
    event("r1", "run.started"),
    event("r2", "run.queued"),
    event("r2", "run.cancelled"),
    event("r1", "run.cancelled"),
  ]);
  expect([...activity.removed]).toEqual(["r2"]);
  expect(activity.queued).toEqual([]);
  expect(activity.working).toBeNull();
});

test("only user messages behind work wait, and a steered one never does", () => {
  const message = (
    id: string,
    runId: string,
    role: "user" | "assistant" = "user",
    steered?: true
  ) => ({ id, role, runId, ...(steered ? { steered } : {}) });
  const messages = [
    message("u1", "r1"),
    message("a1", "r1", "assistant"),
    message("s1", "r1", "user", true),
    message("u2", "r2"),
    message("a2", "r2", "assistant"),
  ];
  const working = threadActivity([
    event("r1", "run.queued"),
    event("r1", "run.started"),
    event("r2", "run.queued"),
  ]);
  expect([...waitingMessages(messages, working)]).toEqual([["u2", "r2"]]);
  // Nothing works: the oldest queued run is about to start, so it does not wait.
  const idle = threadActivity([event("r2", "run.queued")]);
  expect(waitingMessages(messages, idle).size).toBe(0);
});
