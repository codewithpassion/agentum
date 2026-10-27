import { describe, expect, test } from "bun:test";

import {
  initialTouchState,
  reduceTouch,
  type TouchEffect,
  type TouchEvent,
  type TouchState,
} from "./desktop-touch.ts";

function run(events: TouchEvent[]): {
  effects: TouchEffect[];
  state: TouchState;
} {
  let state = initialTouchState;
  const effects: TouchEffect[] = [];
  for (const event of events) {
    const step = reduceTouch(state, event);
    ({ state } = step);
    effects.push(...step.effects);
  }
  return { effects, state };
}

const at = (x: number, y: number) => ({ x, y });

describe("reduceTouch", () => {
  test("a tap is a left click where the finger landed", () => {
    const { effects, state } = run([
      { id: 1, point: at(50, 60), type: "down" },
      { id: 1, point: at(53, 62), type: "move" },
      { id: 1, type: "up" },
    ]);
    expect(effects).toEqual([
      { at: at(50, 60), button: "left", type: "click" },
    ]);
    expect(state).toEqual(initialTouchState);
  });

  test("a long press is one right click and the lift adds nothing", () => {
    const { effects } = run([
      { id: 1, point: at(50, 60), type: "down" },
      { type: "longpress" },
      { id: 1, type: "up" },
    ]);
    expect(effects).toEqual([
      { at: at(50, 60), button: "right", type: "click" },
    ]);
  });

  test("a long press after the finger moved away does nothing", () => {
    const { effects } = run([
      { id: 1, point: at(0, 0), type: "down" },
      { id: 1, point: at(40, 0), type: "move" },
      { type: "longpress" },
    ]);
    expect(effects.some((effect) => effect.type === "click")).toBe(false);
  });

  test("a one-finger drag presses at the start, moves, and releases at the end", () => {
    const { effects } = run([
      { id: 1, point: at(10, 10), type: "down" },
      { id: 1, point: at(40, 10), type: "move" },
      { id: 1, point: at(80, 30), type: "move" },
      { id: 1, type: "up" },
    ]);
    expect(effects).toEqual([
      { at: at(10, 10), type: "move" },
      { at: at(10, 10), type: "press" },
      { at: at(40, 10), type: "move" },
      { at: at(80, 30), type: "move" },
      { at: at(80, 30), type: "release" },
    ]);
  });

  test("a two-finger drag scrolls against the fingers and never clicks", () => {
    const { effects, state } = run([
      { id: 1, point: at(100, 200), type: "down" },
      { id: 2, point: at(140, 200), type: "down" },
      { id: 1, point: at(100, 150), type: "move" },
      { id: 2, point: at(140, 150), type: "move" },
      { id: 1, type: "up" },
      { id: 2, type: "up" },
    ]);
    const scrolls = effects.filter((effect) => effect.type === "scroll");
    expect(effects.every((effect) => effect.type === "scroll")).toBe(true);
    const totalDy = scrolls.reduce(
      (sum, effect) => sum + (effect.type === "scroll" ? effect.dy : 0),
      0
    );
    expect(totalDy).toBe(50);
    expect(state).toEqual(initialTouchState);
  });

  test("a second finger during a drag lets go of the button", () => {
    const { effects } = run([
      { id: 1, point: at(10, 10), type: "down" },
      { id: 1, point: at(60, 10), type: "move" },
      { id: 2, point: at(90, 90), type: "down" },
    ]);
    expect(effects.at(-1)).toEqual({ at: at(60, 10), type: "release" });
  });

  test("lifting one of two fingers ends the scroll until both are up", () => {
    const { effects } = run([
      { id: 1, point: at(0, 0), type: "down" },
      { id: 2, point: at(30, 0), type: "down" },
      { id: 1, type: "up" },
      { id: 2, point: at(30, 80), type: "move" },
      { id: 2, type: "up" },
    ]);
    expect(effects).toEqual([]);
  });

  test("cancel releases a held button", () => {
    const { effects, state } = run([
      { id: 1, point: at(0, 0), type: "down" },
      { id: 1, point: at(50, 0), type: "move" },
      { type: "cancel" },
    ]);
    expect(effects.at(-1)).toEqual({ at: at(50, 0), type: "release" });
    expect(state).toEqual(initialTouchState);
  });
});
