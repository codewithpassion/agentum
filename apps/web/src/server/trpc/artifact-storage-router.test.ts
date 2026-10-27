import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { appRouter } from "./router.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
const artifactId = crypto.randomUUID();

const makeCaller = () => {
  const calls: { input: unknown; method: string; principal: unknown }[] = [];
  const record =
    (method: string, result: unknown) =>
    (callPrincipal: unknown, input: unknown) => {
      calls.push({ input, method, principal: callPrincipal });
      return Promise.resolve(result);
    };
  const caller = appRouter.createCaller({
    principal,
    services: {
      artifactStorage: {
        delete: record("delete", {}),
        get: record("get", { value: { a: 1 } }),
        list: record("list", { keys: ["a"] }),
        set: record("set", {}),
      },
    },
  } as unknown as Context);
  return { caller, calls };
};

test("each procedure forwards the principal and input", async () => {
  const { calls, caller } = makeCaller();
  const get = { artifactId, key: "k", scope: "viewer" } as const;
  const list = { artifactId, prefix: "p", scope: "shared" } as const;
  const set = {
    artifactId,
    key: "k",
    scope: "shared" as const,
    value: [1],
  };
  const del = { artifactId, key: "k", scope: "viewer" } as const;
  expect(await caller.artifacts.storageGet(get)).toEqual({ value: { a: 1 } });
  expect(await caller.artifacts.storageList(list)).toEqual({ keys: ["a"] });
  expect(await caller.artifacts.storageSet(set)).toEqual({});
  expect(await caller.artifacts.storageDelete(del)).toEqual({});
  expect(calls).toEqual([
    { input: get, method: "get", principal },
    { input: list, method: "list", principal },
    { input: set, method: "set", principal },
    { input: del, method: "delete", principal },
  ]);
});

test("input is validated", async () => {
  const { calls, caller } = makeCaller();
  await expect(
    caller.artifacts.storageGet({
      artifactId,
      key: "k",
      scope: "nope",
    } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.artifacts.storageGet({
      artifactId: "not-a-uuid",
      key: "k",
      scope: "viewer",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.artifacts.storageSet({
      artifactId,
      key: "",
      scope: "viewer",
      value: 1,
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(calls).toHaveLength(0);
});

test("an anonymous caller is unauthorized", async () => {
  const anonymous = appRouter.createCaller({
    principal: { kind: "anonymous" },
    services: {},
  } as unknown as Context);
  await expect(
    anonymous.artifacts.storageGet({ artifactId, key: "k", scope: "viewer" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
