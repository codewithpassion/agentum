import { describe, expect, test } from "bun:test";
import type { DesktopAction } from "#/lib/desktop-input";
import { createInputCoalescer } from "./desktop-input-coalescer";

const move = (x: number): DesktopAction => ({ type: "mouse_move", x, y: 0 });
const down: DesktopAction = { button: "left", type: "mouse_down" };
const up: DesktopAction = { button: "left", type: "mouse_up" };
const key: DesktopAction = { keys: "Return", type: "key" };

const setup = () => {
  const sent: DesktopAction[][] = [];
  let clock = 1000;
  let pending: (() => void) | null = null;
  const coalescer = createInputCoalescer({
    now: () => clock,
    schedule: (run) => {
      pending = run;
      return () => {
        pending = null;
      };
    },
    send: (batch) => {
      sent.push(batch);
      return true;
    },
  });
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    coalescer,
    frame: () => {
      const run = pending;
      pending = null;
      run?.();
    },
    isScheduled: () => pending !== null,
    sent,
  };
};

describe("input coalescer", () => {
  test("moves within one frame collapse to the newest", () => {
    const { coalescer, frame, sent } = setup();

    coalescer.push([move(1), move(2), move(3)]);
    frame();

    expect(sent).toEqual([[move(3)]]);
  });

  test("a move held back is sent before the action that follows it", () => {
    const { coalescer, frame, sent } = setup();

    coalescer.push([move(5), down, key]);
    frame();

    expect(sent).toEqual([[move(5), down, key]]);
  });

  test("idle moves are spaced 50 ms apart", () => {
    const { advance, coalescer, frame, isScheduled, sent } = setup();
    coalescer.push([move(1)]);
    frame();
    advance(10);

    coalescer.push([move(2)]);
    frame();

    expect(sent).toEqual([[move(1)]]);
    expect(isScheduled()).toBe(true);
    advance(50);
    frame();
    expect(sent).toEqual([[move(1)], [move(2)]]);
    expect(isScheduled()).toBe(false);
  });

  test("moves are sent every frame while a button is down", () => {
    const { advance, coalescer, frame, sent } = setup();
    coalescer.push([down]);
    frame();
    advance(16);
    coalescer.push([move(1)]);
    frame();
    advance(16);
    coalescer.push([move(2)]);
    frame();
    coalescer.push([up]);
    frame();

    expect(sent).toEqual([[down], [move(1)], [move(2)], [up]]);
  });

  test("flush sends the held move at once, unless moves are dropped", () => {
    const first = setup();
    first.coalescer.push([move(1), key, move(2)]);
    first.coalescer.flush();
    expect(first.sent).toEqual([[move(1), key, move(2)]]);

    const second = setup();
    second.coalescer.push([move(1), key, move(2)]);
    second.coalescer.flush({ dropMoves: true });
    expect(second.sent).toEqual([[key]]);
  });

  test("reset forgets what was queued", () => {
    const { coalescer, frame, sent } = setup();
    coalescer.push([key, move(1)]);

    coalescer.reset();
    frame();

    expect(sent).toEqual([]);
  });
});
