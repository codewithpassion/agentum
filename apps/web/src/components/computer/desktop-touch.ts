/**
 * Touch gestures on the remote screen as a pure state machine. One finger taps
 * (left click), holds (right click) or drags (the pointer moves with the left
 * button down). Two fingers drag to scroll. The hook feeds it pointer events
 * and a long-press timer, and turns the effects it returns into desktop input.
 */

export const LONG_PRESS_MS = 500;
/** How far a finger may wander and still count as a tap or a hold. */
export const TOUCH_SLOP_PX = 10;

export interface TouchPoint {
  x: number;
  y: number;
}

export type TouchEffect =
  | { at: TouchPoint; button: "left" | "right"; type: "click" }
  | { at: TouchPoint; type: "move" | "press" | "release" }
  /** Finger movement in screen pixels; content follows the fingers, so the scroll runs opposite. */
  | { dx: number; dy: number; type: "scroll" };

export type TouchEvent =
  | { id: number; point: TouchPoint; type: "down" | "move" }
  | { id: number; type: "up" }
  | { type: "cancel" | "longpress" };

export interface TouchState {
  last: TouchPoint;
  /** `ignored` waits for every finger to lift after a gesture has ended early. */
  phase: "dragging" | "idle" | "ignored" | "pending" | "scrolling";
  pointers: Readonly<Record<number, TouchPoint>>;
  start: TouchPoint;
}

const ORIGIN: TouchPoint = { x: 0, y: 0 };

export const initialTouchState: TouchState = {
  last: ORIGIN,
  phase: "idle",
  pointers: {},
  start: ORIGIN,
};

const farFrom = (a: TouchPoint, b: TouchPoint): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) > TOUCH_SLOP_PX;

/** The point halfway between the fingers. */
export function midpoint(points: readonly TouchPoint[]): TouchPoint {
  if (points.length === 0) {
    return ORIGIN;
  }
  const sum = points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
    ORIGIN
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

const without = (
  pointers: Readonly<Record<number, TouchPoint>>,
  id: number
): Record<number, TouchPoint> => {
  const rest = { ...pointers };
  delete rest[id];
  return rest;
};

const countOf = (pointers: Readonly<Record<number, TouchPoint>>): number =>
  Object.keys(pointers).length;

const pointsOf = (
  pointers: Readonly<Record<number, TouchPoint>>
): TouchPoint[] => Object.values(pointers);

interface Step {
  effects: TouchEffect[];
  state: TouchState;
}

function onDown(state: TouchState, id: number, point: TouchPoint): Step {
  const pointers = { ...state.pointers, [id]: point };
  if (countOf(pointers) === 1) {
    return {
      effects: [],
      state: { last: point, phase: "pending", pointers, start: point },
    };
  }
  // A second finger turns the gesture into a scroll and lets go of any drag.
  const effects: TouchEffect[] =
    state.phase === "dragging" ? [{ at: state.last, type: "release" }] : [];
  return {
    effects,
    state: {
      ...state,
      last: midpoint(pointsOf(pointers)),
      phase: "scrolling",
      pointers,
    },
  };
}

function onMove(state: TouchState, id: number, point: TouchPoint): Step {
  if (state.pointers[id] === undefined) {
    return { effects: [], state };
  }
  const pointers = { ...state.pointers, [id]: point };
  if (state.phase === "pending" && farFrom(point, state.start)) {
    return {
      effects: [
        { at: state.start, type: "move" },
        { at: state.start, type: "press" },
        { at: point, type: "move" },
      ],
      state: { ...state, last: point, phase: "dragging", pointers },
    };
  }
  if (state.phase === "dragging") {
    return {
      effects: [{ at: point, type: "move" }],
      state: { ...state, last: point, pointers },
    };
  }
  if (state.phase === "scrolling") {
    const mid = midpoint(pointsOf(pointers));
    return {
      effects: [
        {
          dx: -(mid.x - state.last.x),
          dy: -(mid.y - state.last.y),
          type: "scroll",
        },
      ],
      state: { ...state, last: mid, pointers },
    };
  }
  return { effects: [], state: { ...state, pointers } };
}

function onUp(state: TouchState, id: number): Step {
  if (state.pointers[id] === undefined) {
    return { effects: [], state };
  }
  const pointers = without(state.pointers, id);
  const remaining = countOf(pointers);
  const done = remaining === 0;
  const idle: TouchState = { ...initialTouchState };
  if (state.phase === "pending" && done) {
    return {
      effects: [{ at: state.start, button: "left", type: "click" }],
      state: idle,
    };
  }
  if (state.phase === "dragging" && done) {
    return { effects: [{ at: state.last, type: "release" }], state: idle };
  }
  if (done) {
    return { effects: [], state: idle };
  }
  // A scroll with one finger left has no meaning: wait until all lift.
  return {
    effects: [],
    state: {
      ...state,
      phase: state.phase === "scrolling" ? "ignored" : state.phase,
      pointers,
    },
  };
}

/** Advances the gesture by one event and says what to do on the desktop. */
export function reduceTouch(state: TouchState, event: TouchEvent): Step {
  switch (event.type) {
    case "down":
      return onDown(state, event.id, event.point);
    case "move":
      return onMove(state, event.id, event.point);
    case "up":
      return onUp(state, event.id);
    case "longpress":
      if (state.phase !== "pending") {
        return { effects: [], state };
      }
      return {
        effects: [{ at: state.start, button: "right", type: "click" }],
        state: { ...state, phase: "ignored" },
      };
    case "cancel":
      return {
        effects:
          state.phase === "dragging"
            ? [{ at: state.last, type: "release" }]
            : [],
        state: { ...initialTouchState },
      };
    default:
      return { effects: [], state };
  }
}
