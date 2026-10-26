import { expect, test } from "bun:test";
import {
  addEditedMark,
  type MarkStorage,
  readEditedMarks,
} from "./edited-marks.ts";

const KEY = "harbourmaster:edited-messages";

const memory = (
  initial: Record<string, string> = {}
): MarkStorage & {
  data: Map<string, string>;
} => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
};

const broken: MarkStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

test("an empty store reads as no marks", () => {
  expect(readEditedMarks(memory())).toEqual(new Set());
});

test("addEditedMark stores ids that readEditedMarks returns", () => {
  const storage = memory();
  addEditedMark("u1", storage);
  addEditedMark("u2", storage);
  addEditedMark("u1", storage);
  expect(storage.data.get(KEY)).toBe(JSON.stringify(["u1", "u2"]));
  expect(readEditedMarks(storage)).toEqual(new Set(["u1", "u2"]));
});

test("invalid JSON, a non-array and non-string entries read as valid strings only", () => {
  expect(readEditedMarks(memory({ [KEY]: "{not json" }))).toEqual(new Set());
  expect(readEditedMarks(memory({ [KEY]: '{"a":1}' }))).toEqual(new Set());
  expect(readEditedMarks(memory({ [KEY]: '["u1", 2, null, "u2"]' }))).toEqual(
    new Set(["u1", "u2"])
  );
});

test("a throwing store reads as no marks and addEditedMark does not throw", () => {
  expect(readEditedMarks(broken)).toEqual(new Set());
  expect(() => addEditedMark("u1", broken)).not.toThrow();
});

test("null storage reads as no marks and addEditedMark does nothing", () => {
  expect(readEditedMarks(null)).toEqual(new Set());
  expect(() => addEditedMark("u1", null)).not.toThrow();
});

test("without a storage argument, sessionStorage is used when it exists", () => {
  const storage = memory();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    addEditedMark("u9");
    expect(readEditedMarks()).toEqual(new Set(["u9"]));
    expect(storage.data.get(KEY)).toBe(JSON.stringify(["u9"]));
  } finally {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("without a storage argument and no sessionStorage, nothing throws", () => {
  expect(readEditedMarks()).toEqual(new Set());
  expect(() => addEditedMark("u1")).not.toThrow();
});
