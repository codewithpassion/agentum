import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AppStore } from "./app-store.ts";
import { appStorePort, viewerStorage } from "./port.ts";
import type { AppStoreScope, AppViewer } from "./types.ts";

// A namespace of real AppStore classes, each over its own in-memory SQLite
// standing in for `ctx.storage.sql`, named by artifact id like the real one.
const fakeNamespace = () => {
  const stores = new Map<string, AppStore>();
  const namespace = {
    get: (id: string) => {
      let store = stores.get(id);
      if (!store) {
        const db = new Database(":memory:");
        const ctx = {
          storage: {
            sql: {
              exec: (sql: string, ...params: (string | number)[]) => ({
                toArray: () => db.query(sql).all(...params),
              }),
            },
          },
        };
        store = new AppStore(ctx as never, {} as never);
        stores.set(id, store);
      }
      return store;
    },
    idFromName: (name: string) => name,
  };
  return namespace as never;
};

const FORBIDDEN = /^forbidden/;
const TOO_LARGE = /^too_large/;

const member = (userId: string): AppViewer => ({ kind: "member", userId });
const link = (dataMode: "snapshot" | "live"): AppViewer => ({
  dataMode,
  kind: "link",
  shareId: "s1",
});

describe("appStorePort", () => {
  test("each artifact has its own storage", async () => {
    const port = appStorePort(fakeNamespace());
    const a: AppStoreScope = { area: "shared", artifactId: "a", viewerKey: "" };
    await port.set(a, "k", "1");
    expect(await port.get(a, "k")).toBe("1");
    expect(await port.get({ ...a, artifactId: "b" }, "k")).toBeNull();
  });

  test("lists by prefix, reports usage and wipes", async () => {
    const port = appStorePort(fakeNamespace());
    const scope: AppStoreScope = {
      area: "viewer",
      artifactId: "a",
      viewerKey: "u:1",
    };
    await port.set(scope, "todo/1", "x");
    await port.set(scope, "todo/2", "y");
    await port.set(scope, "other", "z");
    expect(await port.list(scope, "todo/", 10)).toEqual([
      { key: "todo/1", value: "x" },
      { key: "todo/2", value: "y" },
    ]);
    const usage = await port.usage("a");
    expect(usage.bytes).toBe(6 + 1 + 6 + 1 + 5 + 1);
    expect(usage.maxBytes).toBe(20 * 1024 * 1024);
    await port.wipe("a");
    expect((await port.usage("a")).bytes).toBe(0);
    await port.delete(scope, "missing");
  });

  test("a value over the limit is refused with too_large", async () => {
    const port = appStorePort(fakeNamespace());
    const scope: AppStoreScope = {
      area: "shared",
      artifactId: "a",
      viewerKey: "",
    };
    await expect(
      port.set(scope, "k", "x".repeat(1024 * 1024 + 1))
    ).rejects.toThrow(TOO_LARGE);
  });
});

describe("viewerStorage", () => {
  test("members write both areas and see only their own viewer area", async () => {
    const port = appStorePort(fakeNamespace());
    const alice = viewerStorage(port, "a", member("alice"));
    const bob = viewerStorage(port, "a", member("bob"));
    await alice.setItem("viewer", "pref", "dark");
    await alice.setItem("shared", "title", "Board");
    expect(await alice.getItem("viewer", "pref")).toBe("dark");
    expect(await bob.getItem("viewer", "pref")).toBeNull();
    expect(await bob.getItem("shared", "title")).toBe("Board");
    expect(await bob.listItems("shared")).toEqual([
      { key: "title", value: "Board" },
    ]);
    await bob.deleteItem("shared", "title");
    expect(await alice.getItem("shared", "title")).toBeNull();
  });

  test("a snapshot link reads the shared area and never writes", async () => {
    const port = appStorePort(fakeNamespace());
    await viewerStorage(port, "a", member("alice")).setItem("shared", "k", "v");
    const snapshot = viewerStorage(port, "a", link("snapshot"));
    expect(await snapshot.getItem("shared", "k")).toBe("v");
    expect(await snapshot.listItems("shared", "k")).toEqual([
      { key: "k", value: "v" },
    ]);
    await expect(snapshot.setItem("shared", "k", "evil")).rejects.toThrow(
      FORBIDDEN
    );
    await expect(snapshot.setItem("viewer", "k", "evil")).rejects.toThrow(
      FORBIDDEN
    );
    await expect(snapshot.deleteItem("shared", "k")).rejects.toThrow(FORBIDDEN);
    await expect(snapshot.deleteItem("viewer", "k")).rejects.toThrow(FORBIDDEN);
    expect(await snapshot.getItem("shared", "k")).toBe("v");
  });

  test("a live link writes its viewer area only", async () => {
    const port = appStorePort(fakeNamespace());
    const live = viewerStorage(port, "a", link("live"));
    await live.setItem("viewer", "k", "v");
    expect(await live.getItem("viewer", "k")).toBe("v");
    await expect(live.setItem("shared", "k", "v")).rejects.toThrow(FORBIDDEN);
    await expect(live.deleteItem("shared", "k")).rejects.toThrow(FORBIDDEN);
  });
});
