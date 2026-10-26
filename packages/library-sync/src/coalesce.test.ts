import { expect, test } from "bun:test";
import { createCoalescer } from "./coalesce.ts";

const fakeClock = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    advance: (ms: number) => {
      const end = now + ms;
      while (timers.size > 0) {
        const [due] = [...timers].sort((a, b) => a[1].at - b[1].at);
        if (!due || due[1].at > end) {
          break;
        }
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
    clearTimeout: (handle: number) => {
      timers.delete(handle);
    },
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
  };
};

test("bursts restart the quiet window and hand over sorted unique paths", () => {
  const clock = fakeClock();
  const batches: string[][] = [];
  const coalescer = createCoalescer({
    clock,
    onBatch: (paths) => {
      batches.push(paths);
    },
  });
  coalescer.add("b");
  clock.advance(1000);
  coalescer.add("a");
  coalescer.add("b");
  clock.advance(1499);
  expect(batches).toEqual([]);
  clock.advance(1);
  expect(batches).toEqual([["a", "b"]]);
  clock.advance(5000);
  expect(batches).toHaveLength(1);
  coalescer.add("c");
  clock.advance(1500);
  expect(batches).toEqual([["a", "b"], ["c"]]);
});

test("continuous adds flush at the five second cap and start fresh", () => {
  const clock = fakeClock();
  const batches: string[][] = [];
  const coalescer = createCoalescer({
    clock,
    onBatch: (paths) => {
      batches.push(paths);
    },
  });
  coalescer.add("a");
  for (let i = 0; i < 4; i += 1) {
    clock.advance(1000);
    coalescer.add("b");
  }
  clock.advance(1000);
  expect(batches).toEqual([["a", "b"]]);
  coalescer.add("c");
  clock.advance(1500);
  expect(batches).toEqual([["a", "b"], ["c"]]);
});

test("flush and cancel clear timers, and empty batches are not delivered", () => {
  const clock = fakeClock();
  const batches: string[][] = [];
  const coalescer = createCoalescer({
    clock,
    onBatch: (paths) => {
      batches.push(paths);
    },
  });
  coalescer.flush();
  coalescer.add("a");
  coalescer.flush();
  coalescer.add("b");
  coalescer.cancel();
  clock.advance(6000);
  expect(batches).toEqual([["a"]]);
});

test("rejections reach onError without blocking a new batch", async () => {
  const clock = fakeClock();
  const errors: unknown[] = [];
  const error = new Error("batch failed");
  const coalescer = createCoalescer({
    clock,
    onBatch: () => Promise.reject(error),
    onError: (reason) => {
      errors.push(reason);
    },
  });
  coalescer.add("a");
  coalescer.flush();
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).toEqual([error]);
  coalescer.add("b");
  clock.advance(1500);
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).toEqual([error, error]);
});
