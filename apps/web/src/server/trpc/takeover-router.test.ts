import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { takeoverRouter } from "./takeover-router.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
test("takeover procedures validate inputs and forward the user", async () => {
  const calls: unknown[] = [];
  const record = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve();
  };
  const caller = takeoverRouter.createCaller({
    principal,
    services: { takeover: { cancel: record, handBack: record, take: record } },
  } as unknown as Context);
  await caller.take({ requestId: "r" });
  await caller.handBack({ note: "done", requestId: "r" });
  await caller.handBack({ requestId: "r" });
  await caller.cancel({ requestId: "r" });
  expect(calls).toEqual([
    [principal, "r"],
    [principal, "r", "done"],
    [principal, "r", undefined],
    [principal, "r"],
  ]);
  await expect(caller.take({ requestId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const anonymous = takeoverRouter.createCaller({
    principal: { kind: "anonymous" },
  } as unknown as Context);
  await expect(anonymous.take({ requestId: "r" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
