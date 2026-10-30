import { expect, test } from "bun:test";
import { freshIds, stableOrder } from "./stable-order.ts";

const items = (...names: string[]) => names.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((item) => item.id);

test("the open row keeps its index when rows arrive above it", () => {
  const next = items("n1", "n2", "a", "b", "c");
  expect(ids(stableOrder(["a", "b", "c"], next, "b"))).toEqual([
    "n1",
    "b",
    "n2",
    "a",
    "c",
  ]);
});

test("the open row keeps its index when rows arrive below it", () => {
  const next = items("a", "b", "c", "n1", "n2");
  expect(ids(stableOrder(["a", "b", "c"], next, "b"))).toEqual([
    "a",
    "b",
    "c",
    "n1",
    "n2",
  ]);
});

test("the open row keeps its index when rows arrive above and below", () => {
  const next = items("n1", "a", "n2", "b", "c", "n3");
  expect(ids(stableOrder(["a", "b", "c"], next, "b"))).toEqual([
    "n1",
    "b",
    "a",
    "n2",
    "c",
    "n3",
  ]);
});

test("an open row missing from the next list leaves the next order", () => {
  const next = items("n1", "a", "c");
  expect(ids(stableOrder(["a", "b", "c"], next, "b"))).toEqual([
    "n1",
    "a",
    "c",
  ]);
});

test("an open row missing from the previous order leaves the next order", () => {
  const next = items("c", "b", "a");
  expect(ids(stableOrder(["a", "c"], next, "b"))).toEqual(["c", "b", "a"]);
});

test("a null open id leaves the next order", () => {
  const next = items("c", "a", "b");
  expect(ids(stableOrder(["a", "b", "c"], next, null))).toEqual([
    "c",
    "a",
    "b",
  ]);
});

test("the open index clamps to the end when the next list is shorter", () => {
  const next = items("a", "b");
  expect(ids(stableOrder(["x", "y", "z", "b"], next, "b"))).toEqual(["a", "b"]);
});

test("the inputs are not mutated", () => {
  const previous = ["a", "b", "c"];
  const next = items("n1", "a", "b", "c");
  const nextCopy = [...next];
  const result = stableOrder(previous, next, "b");
  expect(previous).toEqual(["a", "b", "c"]);
  expect(next).toEqual(nextCopy);
  expect(result).not.toBe(next);
});

test("the result is a copy when nothing moves", () => {
  const next = items("a", "b");
  const result = stableOrder(["a", "b"], next, null);
  expect(result).toEqual(next);
  expect(result).not.toBe(next);
});

test("fresh ids are the ids not on screen before", () => {
  const fresh = freshIds(["a", "b"], items("n1", "a", "n2", "b"));
  expect([...fresh]).toEqual(["n1", "n2"]);
});

test("nothing is fresh when the previous order is empty", () => {
  expect(freshIds([], items("a", "b")).size).toBe(0);
});

test("nothing is fresh when every id was on screen", () => {
  expect(freshIds(["a", "b", "c"], items("c", "a")).size).toBe(0);
});
