import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  createAppStoreCore,
  MAX_KEY_BYTES,
  MAX_LIST_LIMIT,
  MAX_VALUE_BYTES,
  type SqlAdapter,
} from "./app-store-core.ts";

const makeCore = (maxBytes?: number) => {
  const db = new Database(":memory:");
  const adapter: SqlAdapter = {
    exec: (q, ...p) => db.query(q).all(...p) as Record<string, unknown>[],
  };
  const core = createAppStoreCore(adapter, maxBytes);
  core.init();
  return core;
};

const QUOTA = /^quota_exceeded/;
const TOO_LARGE = /^too_large/;

const keysOf = (items: { key: string }[]): string[] => items.map((i) => i.key);

describe("areas", () => {
  test("viewer area is isolated per viewerKey", () => {
    const core = makeCore();
    core.set("viewer", "u:1", "k", "one");
    core.set("viewer", "u:2", "k", "two");
    expect(core.get("viewer", "u:1", "k")).toBe("one");
    expect(core.get("viewer", "u:2", "k")).toBe("two");
    expect(core.get("viewer", "u:3", "k")).toBeNull();
  });

  test("shared area is shared across viewerKeys", () => {
    const core = makeCore();
    core.set("shared", "u:1", "k", "v");
    expect(core.get("shared", "u:2", "k")).toBe("v");
    expect(keysOf(core.list("shared", "l:9", "", 10))).toEqual(["k"]);
    core.delete("shared", "u:2", "k");
    expect(core.get("shared", "u:1", "k")).toBeNull();
  });

  test("areas are isolated from each other", () => {
    const core = makeCore();
    core.set("shared", "u:1", "k", "shared");
    core.set("viewer", "u:1", "k", "viewer");
    expect(core.get("shared", "u:1", "k")).toBe("shared");
    expect(core.get("viewer", "u:1", "k")).toBe("viewer");
    core.delete("viewer", "u:1", "k");
    expect(core.get("shared", "u:1", "k")).toBe("shared");
  });
});

describe("get, set, delete", () => {
  test("a missing key is null", () => {
    expect(makeCore().get("shared", "", "nope")).toBeNull();
  });

  test("set replaces", () => {
    const core = makeCore();
    core.set("shared", "", "k", "a");
    core.set("shared", "", "k", "b");
    expect(core.get("shared", "", "k")).toBe("b");
    expect(core.list("shared", "", "", 10)).toHaveLength(1);
  });

  test("delete removes and ignores a missing key", () => {
    const core = makeCore();
    core.set("shared", "", "k", "a");
    core.delete("shared", "", "k");
    core.delete("shared", "", "k");
    expect(core.get("shared", "", "k")).toBeNull();
  });
});

describe("list", () => {
  const seed = () => {
    const core = makeCore();
    for (const key of ["b", "a2", "a1", "a%x", "a_y", "ab", "é1", "é2", "z"]) {
      core.set("shared", "", key, `v-${key}`);
    }
    return core;
  };

  test("empty prefix lists everything ordered by key", () => {
    const keys = keysOf(seed().list("shared", "", "", 100));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(9);
  });

  test("returns the value with the key", () => {
    expect(seed().list("shared", "", "a1", 10)).toEqual([
      { key: "a1", value: "v-a1" },
    ]);
  });

  test("matches a prefix literally", () => {
    const core = seed();
    expect(keysOf(core.list("shared", "", "a", 100))).toEqual([
      "a%x",
      "a1",
      "a2",
      "a_y",
      "ab",
    ]);
    expect(keysOf(core.list("shared", "", "a%", 100))).toEqual(["a%x"]);
    expect(keysOf(core.list("shared", "", "a_", 100))).toEqual(["a_y"]);
  });

  test("matches a non-ASCII prefix", () => {
    expect(keysOf(seed().list("shared", "", "é", 100))).toEqual(["é1", "é2"]);
  });

  test("honours the limit and clamps it", () => {
    const core = seed();
    expect(keysOf(core.list("shared", "", "", 2))).toHaveLength(2);
    expect(core.list("shared", "", "", 0)).toHaveLength(1);
    expect(core.list("shared", "", "", -5)).toHaveLength(1);
    expect(MAX_LIST_LIMIT).toBe(1000);
  });

  test("clamps a huge limit to the maximum", () => {
    const core = makeCore();
    for (let i = 0; i < MAX_LIST_LIMIT + 5; i += 1) {
      core.set("shared", "", `k${String(i).padStart(5, "0")}`, "");
    }
    expect(core.list("shared", "", "", 1_000_000)).toHaveLength(MAX_LIST_LIMIT);
  });

  test("lists only the viewer's own rows", () => {
    const core = makeCore();
    core.set("viewer", "u:1", "a", "1");
    core.set("viewer", "u:2", "b", "2");
    expect(keysOf(core.list("viewer", "u:1", "", 10))).toEqual(["a"]);
  });
});

describe("cap", () => {
  // Row bytes are key plus value, so "k" + 9 chars is 10 bytes.
  test("a refused write changes nothing", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(79)); // 80 bytes
    expect(() => core.set("shared", "", "b", "y".repeat(20))).toThrow(QUOTA);
    expect(core.get("shared", "", "b")).toBeNull();
    expect(core.usage().bytes).toBe(80);
  });

  test("a refused replacement keeps the old value", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(49));
    expect(() => core.set("shared", "", "a", "y".repeat(100))).toThrow(QUOTA);
    expect(core.get("shared", "", "a")).toBe("x".repeat(49));
  });

  test("a write landing exactly on the cap succeeds", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(99));
    expect(core.usage().bytes).toBe(100);
    expect(() => core.set("shared", "", "b", "")).toThrow(QUOTA);
  });

  test("a smaller replacement succeeds when full", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(99));
    core.set("shared", "", "a", "x".repeat(10));
    expect(core.usage().bytes).toBe(11);
  });

  test("a same-size replacement succeeds when full", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(99));
    core.set("shared", "", "a", "y".repeat(99));
    expect(core.get("shared", "", "a")).toBe("y".repeat(99));
  });

  test("delete frees room", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "x".repeat(99));
    core.delete("shared", "", "a");
    core.set("shared", "", "b", "y".repeat(99));
    expect(core.usage().bytes).toBe(100);
  });

  test("the cap counts all areas and viewers together", () => {
    const core = makeCore(100);
    core.set("viewer", "u:1", "a", "x".repeat(49));
    core.set("shared", "", "b", "x".repeat(49));
    expect(() => core.set("viewer", "u:2", "c", "x")).toThrow(QUOTA);
  });

  test("multibyte values count by bytes", () => {
    const core = makeCore(100);
    core.set("shared", "", "é", "é".repeat(30)); // 2 + 60 bytes
    expect(core.usage().bytes).toBe(62);
    // 40 characters would fit by count, but 1 + 38 bytes brings the total to 101.
    expect(() => core.set("shared", "", "k", "é".repeat(19))).toThrow(QUOTA);
    core.set("shared", "", "k", "é".repeat(18)); // 1 + 36, total 99
    expect(core.usage().bytes).toBe(99);
  });
});

describe("too_large", () => {
  test("a key over the limit throws before any write", () => {
    const core = makeCore();
    expect(() =>
      core.set("shared", "", "k".repeat(MAX_KEY_BYTES + 1), "v")
    ).toThrow(TOO_LARGE);
    expect(core.usage().bytes).toBe(0);
  });

  test("a key at the limit is accepted", () => {
    const core = makeCore();
    core.set("shared", "", "k".repeat(MAX_KEY_BYTES), "v");
    expect(core.usage().bytes).toBe(MAX_KEY_BYTES + 1);
  });

  test("the key limit counts bytes, not characters", () => {
    const core = makeCore();
    expect(() =>
      core.set("shared", "", "é".repeat(MAX_KEY_BYTES / 2 + 1), "v")
    ).toThrow(TOO_LARGE);
  });

  test("a value over the limit throws before any write", () => {
    const core = makeCore();
    expect(() =>
      core.set("shared", "", "k", "v".repeat(MAX_VALUE_BYTES + 1))
    ).toThrow(TOO_LARGE);
    expect(core.get("shared", "", "k")).toBeNull();
  });

  test("a value at the limit is accepted", () => {
    const core = makeCore();
    core.set("shared", "", "k", "v".repeat(MAX_VALUE_BYTES));
    expect(core.usage().bytes).toBe(MAX_VALUE_BYTES + 1);
  });
});

describe("usage and wipe", () => {
  test("usage sums bytes over all rows and reports the cap", () => {
    const core = makeCore(500);
    expect(core.usage()).toEqual({ bytes: 0, maxBytes: 500 });
    core.set("shared", "", "ab", "cde");
    core.set("viewer", "u:1", "f", "gh");
    expect(core.usage()).toEqual({ bytes: 8, maxBytes: 500 });
  });

  test("wipe empties everything and the store still works", () => {
    const core = makeCore(100);
    core.set("shared", "", "a", "1");
    core.set("viewer", "u:1", "b", "2");
    core.wipe();
    expect(core.usage().bytes).toBe(0);
    expect(core.list("shared", "", "", 10)).toEqual([]);
    expect(core.get("viewer", "u:1", "b")).toBeNull();
    core.set("shared", "", "c", "3");
    expect(core.get("shared", "", "c")).toBe("3");
  });
});

test("app error slots persist across restarts and count drops over a sliding ten seconds", () => {
  const db = new Database(":memory:");
  const adapter: SqlAdapter = {
    exec: (q, ...p) => db.query(q).all(...p) as Record<string, unknown>[],
  };
  const first = createAppStoreCore(adapter);
  first.init();
  expect(first.errorSlot(1000)).toEqual({ dropped: 0 });
  for (let i = 0; i < 100; i += 1) {
    expect(first.errorSlot(1001 + i)).toBeNull();
  }
  const restarted = createAppStoreCore(adapter);
  restarted.init();
  expect(restarted.errorSlot(10_999)).toBeNull();
  expect(restarted.errorSlot(11_000)).toEqual({ dropped: 101 });
  expect(restarted.errorSlot(11_001)).toBeNull();
  expect(restarted.errorSlot(21_000)).toEqual({ dropped: 1 });
  expect(makeCore().errorSlot(11_001)).toEqual({ dropped: 0 });
});
