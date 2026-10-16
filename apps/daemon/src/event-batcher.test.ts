import { describe, expect, test } from "bun:test";
import type { RunEventInput } from "@repo/protocol/machine";
import type { Timers } from "./client.ts";
import {
  BATCH_INTERVAL_MS,
  createEventBatcher,
  type EventBatcherOptions,
} from "./event-batcher.ts";

const TIMER_LABEL = "event-batch";
const MAX_BATCH = 100;

interface PendingTimer {
  readonly delay: number;
  readonly fn: () => void;
  readonly id: number;
  readonly kind: "after" | "every";
  readonly label: string;
}

const fakeTimers = () => {
  let nextId = 0;
  let pending: PendingTimer[] = [];

  const add = (
    kind: "after" | "every",
    delay: number,
    fn: () => void,
    label = ""
  ) => {
    nextId += 1;
    const timer: PendingTimer = { delay, fn, id: nextId, kind, label };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other.id !== timer.id);
    };
  };

  const timers: Timers = {
    after: (ms, fn, label) => add("after", ms, fn, label),
    every: (ms, fn, label) => add("every", ms, fn, label),
  };

  const find = (label: string) => pending.find((t) => t.label === label);

  /** Runs the pending timer with this label. A one-shot timer is removed first. */
  const fire = (label: string) => {
    const timer = find(label);
    if (!timer) {
      throw new Error(`no pending timer labelled ${label}`);
    }
    if (timer.kind === "after") {
      pending = pending.filter((other) => other.id !== timer.id);
    }
    timer.fn();
  };

  return { find, fire, pending: () => pending, timers };
};

/** Records each batch sent. The behaviour of the next send is set by the test. */
const fakeSend = () => {
  const calls: RunEventInput[][] = [];
  let behaviour: () => Promise<void> = () => Promise.resolve();
  const send = (events: RunEventInput[]) => {
    calls.push(events);
    return behaviour();
  };
  return {
    calls,
    respond: (next: () => Promise<void>) => {
      behaviour = next;
    },
    send,
  };
};

const setup = (overrides: Partial<EventBatcherOptions> = {}) => {
  const timers = fakeTimers();
  const sender = fakeSend();
  const errors: unknown[] = [];
  const batcher = createEventBatcher({
    onError: (error) => {
      errors.push(error);
    },
    send: sender.send,
    timers: timers.timers,
    ...overrides,
  });
  return { batcher, errors, sender, timers };
};

const event = (n: number): Pick<RunEventInput, "payload" | "type"> => ({
  payload: { n },
  type: "tool.call",
});

const seqsOf = (batches: RunEventInput[][]) =>
  batches.map((batch) => batch.map((item) => item.seq));

const payloadsOf = (batch: RunEventInput[]) =>
  batch.map((item) => item.payload.n);

/** Lets every promise chain already started run to its end. */
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const transientError = () => new Error("network down");
const conflictError = () =>
  Object.assign(new Error("Conflict"), { status: 409 });

describe("numbering and ticks", () => {
  test("seq starts at 1 and keeps counting across batches", async () => {
    const { batcher, sender, timers } = setup();
    batcher.start();

    batcher.push(event(1));
    batcher.push(event(2));
    timers.fire(TIMER_LABEL);
    await settle();
    batcher.push(event(3));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(seqsOf(sender.calls)).toEqual([[1, 2], [3]]);
  });

  test("each tick sends one batch holding the events pushed since the last tick", async () => {
    const { batcher, sender, timers } = setup();
    batcher.start();

    batcher.push(event(1));
    timers.fire(TIMER_LABEL);
    await settle();
    batcher.push(event(2));
    batcher.push(event(3));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(sender.calls.map(payloadsOf)).toEqual([[1], [2, 3]]);
  });

  test("a tick with nothing queued sends nothing", async () => {
    const { batcher, sender, timers } = setup();
    batcher.start();

    timers.fire(TIMER_LABEL);
    await settle();

    expect(sender.calls).toEqual([]);
  });

  test("start uses the 500 ms interval", () => {
    const { batcher, timers } = setup();
    batcher.start();

    expect(timers.find(TIMER_LABEL)?.delay).toBe(BATCH_INTERVAL_MS);
    expect(BATCH_INTERVAL_MS).toBe(500);
  });

  test("stop cancels the timer and does not flush", async () => {
    const { batcher, sender, timers } = setup();
    batcher.start();
    batcher.push(event(1));

    batcher.stop();
    await settle();

    expect(timers.pending()).toEqual([]);
    expect(timers.find(TIMER_LABEL)).toBeUndefined();
    expect(sender.calls).toEqual([]);
  });
});

describe("serial sends", () => {
  test("a slow send blocks the next one, and flush waits for both", async () => {
    const { batcher, sender, timers } = setup();
    let finishFirst: () => void = () => undefined;
    sender.respond(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    );
    batcher.start();

    batcher.push(event(1));
    timers.fire(TIMER_LABEL);
    await settle();
    batcher.push(event(2));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(sender.calls.map(payloadsOf)).toEqual([[1]]);

    sender.respond(() => Promise.resolve());
    finishFirst();
    await batcher.flush();

    expect(sender.calls.map(payloadsOf)).toEqual([[1], [2]]);
  });

  test("flush does not resolve until a send in flight has finished", async () => {
    const { batcher, sender } = setup();
    let finish: () => void = () => undefined;
    sender.respond(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    batcher.push(event(1));

    let settled = false;
    const flushed = batcher.flush().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await flushed;
    expect(settled).toBe(true);
  });
});

describe("failures", () => {
  test("a transient error keeps the batch, and the next tick resends it with later events in order", async () => {
    const { batcher, errors, sender, timers } = setup();
    batcher.start();
    sender.respond(() => Promise.reject(transientError()));

    batcher.push(event(1));
    batcher.push(event(2));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(errors).toHaveLength(1);

    sender.respond(() => Promise.resolve());
    batcher.push(event(3));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(sender.calls.map(payloadsOf)).toEqual([
      [1, 2],
      [1, 2, 3],
    ]);
    expect(seqsOf(sender.calls)).toEqual([
      [1, 2],
      [1, 2, 3],
    ]);
  });

  test("a permanent error drops the batch and calls onError", async () => {
    const { batcher, errors, sender, timers } = setup();
    batcher.start();
    sender.respond(() => Promise.reject(conflictError()));

    batcher.push(event(1));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    sender.respond(() => Promise.resolve());
    batcher.push(event(2));
    timers.fire(TIMER_LABEL);
    await settle();

    expect(sender.calls.map(payloadsOf)).toEqual([[1], [2]]);
    expect(seqsOf(sender.calls)).toEqual([[1], [2]]);
  });

  test("isPermanent overrides the default status check", async () => {
    const { batcher, sender } = setup({ isPermanent: () => false });
    sender.respond(() => Promise.reject(conflictError()));
    batcher.push(event(1));

    await batcher.flush();
    sender.respond(() => Promise.resolve());
    await batcher.flush();

    expect(sender.calls.map(payloadsOf)).toEqual([[1], [1]]);
  });

  test("a 500 is retried, not dropped", async () => {
    const { batcher, sender } = setup();
    const serverError = Object.assign(new Error("boom"), { status: 500 });
    sender.respond(() => Promise.reject(serverError));
    batcher.push(event(1));

    await batcher.flush();
    sender.respond(() => Promise.resolve());
    await batcher.flush();

    expect(sender.calls.map(payloadsOf)).toEqual([[1], [1]]);
  });

  test("flush resolves without rejecting when send rejects", async () => {
    const { batcher, errors, sender } = setup();
    sender.respond(() => Promise.reject(transientError()));
    batcher.push(event(1));

    await expect(batcher.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("batch size", () => {
  test("a queue larger than the cap is split into ordered batches", async () => {
    const { batcher, sender } = setup();
    const total = 2 * MAX_BATCH + 50;
    for (let n = 1; n <= total; n += 1) {
      batcher.push(event(n));
    }

    await batcher.flush();

    expect(sender.calls.map((batch) => batch.length)).toEqual([
      MAX_BATCH,
      MAX_BATCH,
      50,
    ]);
    expect(seqsOf(sender.calls).flat()).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
  });
});
