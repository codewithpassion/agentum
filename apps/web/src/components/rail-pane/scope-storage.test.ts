import { expect, test } from "bun:test";
import {
  createScopeStore,
  readScope,
  SCOPE_KEY,
  writeScope,
} from "./scope-storage.ts";

const memory = (values: Record<string, string> = {}) => {
  const store = new Map(Object.entries(values));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  };
};

const blocked = {
  getItem: () => {
    throw new Error("storage is blocked");
  },
  setItem: () => {
    throw new Error("storage is blocked");
  },
};

test("reads Everyone when that was stored", () => {
  expect(readScope(() => memory({ [SCOPE_KEY]: "everyone" }))).toBe("everyone");
});

test("reads Mine when nothing or anything else was stored", () => {
  expect(readScope(() => memory())).toBe("mine");
  expect(readScope(() => memory({ [SCOPE_KEY]: "other" }))).toBe("mine");
});

test("reads Mine when storage throws on read", () => {
  expect(readScope(() => blocked)).toBe("mine");
});

test("reads Mine when reaching storage throws", () => {
  expect(
    readScope(() => {
      throw new Error("access denied");
    })
  ).toBe("mine");
});

test("writes the scope under the rail key", () => {
  const store = memory();
  writeScope(() => store, "everyone");
  expect(store.store.get(SCOPE_KEY)).toBe("everyone");
});

test("a write to blocked storage does not throw", () => {
  expect(() => writeScope(() => blocked, "everyone")).not.toThrow();
});

test("the store holds the choice in memory when storage is blocked, and tells its subscribers", () => {
  const store = createScopeStore(() => blocked);
  const heard: string[] = [];
  const unsubscribe = store.subscribe(() => heard.push(store.get()));

  expect(store.get()).toBe("mine");
  store.set("everyone");
  expect(store.get()).toBe("everyone");
  store.set("everyone");
  unsubscribe();
  store.set("mine");

  expect(heard).toEqual(["everyone"]);
});

test("the store reads the stored choice once and writes changes through", () => {
  const storage = memory({ [SCOPE_KEY]: "everyone" });
  const store = createScopeStore(() => storage);

  expect(store.get()).toBe("everyone");
  store.set("mine");
  expect(storage.store.get(SCOPE_KEY)).toBe("mine");
});
