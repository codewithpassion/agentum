import { expect, test } from "bun:test";
import type { Clock } from "../runs/types.ts";
import type { SlackCallResult } from "./client.ts";
import { withRetry } from "./post.ts";

type Result = SlackCallResult<{ ts: string }>;

/** A clock whose sleeps resolve at once and are recorded. */
const recordingClock = () => {
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => new Date("2026-10-16T10:00:00.000Z"),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { clock, sleeps };
};

/** A call that answers each result in turn, and fails if asked for more. */
const scripted = (results: Result[]) => {
  let calls = 0;
  const call = (): Promise<Result> => {
    const next = results[calls];
    calls += 1;
    if (!next) {
      throw new Error("the call was made more often than scripted");
    }
    return Promise.resolve(next);
  };
  return { call, calls: () => calls };
};

const OK: Result = { kind: "ok", ts: "1.5" };
const TRANSIENT: Result = { error: "http_500", kind: "transient" };

test("withRetry returns an ok result at once without sleeping", async () => {
  const { clock, sleeps } = recordingClock();
  const script = scripted([OK]);

  const result = await withRetry(clock, script.call);

  expect(result).toEqual(OK);
  expect(script.calls()).toBe(1);
  expect(sleeps).toEqual([]);
});

test("withRetry retries a transient result and succeeds on the second call after 500 ms", async () => {
  const { clock, sleeps } = recordingClock();
  const script = scripted([TRANSIENT, OK]);

  const result = await withRetry(clock, script.call);

  expect(result).toEqual(OK);
  expect(script.calls()).toBe(2);
  expect(sleeps).toEqual([500]);
});

test("withRetry waits the Retry-After seconds after a rate limit", async () => {
  const { clock, sleeps } = recordingClock();
  const script = scripted([{ kind: "rate_limited", retryAfterSeconds: 2 }, OK]);

  const result = await withRetry(clock, script.call);

  expect(result).toEqual(OK);
  expect(script.calls()).toBe(2);
  expect(sleeps).toEqual([2000]);
});

test("withRetry caps a long Retry-After at 5 seconds", async () => {
  const { clock, sleeps } = recordingClock();
  const script = scripted([
    { kind: "rate_limited", retryAfterSeconds: 60 },
    OK,
  ]);

  const result = await withRetry(clock, script.call);

  expect(result).toEqual(OK);
  expect(sleeps).toEqual([5000]);
});

test("withRetry gives up after three calls and returns the last result", async () => {
  const { clock, sleeps } = recordingClock();
  const last: Result = { error: "http_503", kind: "transient" };
  const script = scripted([TRANSIENT, TRANSIENT, last]);

  const result = await withRetry(clock, script.call);

  expect(result).toBe(last);
  expect(script.calls()).toBe(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("withRetry returns a config result after one call", async () => {
  const { clock, sleeps } = recordingClock();
  const config: Result = { error: "channel_not_found", kind: "config" };
  const script = scripted([config, OK]);

  const result = await withRetry(clock, script.call);

  expect(result).toBe(config);
  expect(script.calls()).toBe(1);
  expect(sleeps).toEqual([]);
});

test("withRetry returns a rejected result after one call", async () => {
  const { clock, sleeps } = recordingClock();
  const rejected: Result = { error: "msg_too_long", kind: "rejected" };
  const script = scripted([rejected, OK]);

  const result = await withRetry(clock, script.call);

  expect(result).toBe(rejected);
  expect(script.calls()).toBe(1);
  expect(sleeps).toEqual([]);
});
