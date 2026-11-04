import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { dictationRouter, dictationWithinLimit } from "./dictation-router.ts";

test("all procedures reject a non-member", async () => {
  const caller = dictationRouter.createCaller({
    principal: null,
    services: {},
    userId: null,
  } as unknown as Context);
  await expect(caller.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.transcribe({ audio: "", final: true })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.polish({ text: "hi" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
test("existing limiter budgets enforce 90 transcriptions and 20 polishes per user", async () => {
  const counts = new Map<string, number>();
  const limit = (budget: number) => ({
    limit: ({ key }: { key: string }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return Promise.resolve({ success: count <= budget });
    },
  });
  const limits = { polish: limit(300), transcribe: limit(30) };
  for (let i = 0; i < 90; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: consume the user budget in order.
    expect(await dictationWithinLimit(limits, "transcribe", "w:u")).toBe(true);
  }
  expect(await dictationWithinLimit(limits, "transcribe", "w:u")).toBe(false);
  expect(await dictationWithinLimit(limits, "transcribe", "w:other")).toBe(
    true
  );
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: consume the user budget in order.
    expect(await dictationWithinLimit(limits, "polish", "w:u")).toBe(true);
  }
  expect(await dictationWithinLimit(limits, "polish", "w:u")).toBe(false);
});

test("member procedures dispatch the principal and input through the service", async () => {
  const principal = {
    kind: "user",
    userId: "u",
    via: "session",
    workspaceId: "w",
  } as const;
  const calls: unknown[] = [];
  const caller = dictationRouter.createCaller({
    principal,
    services: {
      dictation: {
        polish: (who: unknown, input: unknown) => {
          calls.push([who, input]);
          return Promise.resolve({ text: "Clean." });
        },
        status: (who: unknown) => {
          calls.push(who);
          return Promise.resolve({ available: true });
        },
        transcribe: (who: unknown, input: unknown) => {
          calls.push([who, input]);
          return Promise.resolve({ text: "raw" });
        },
      },
    },
    userId: "u",
  } as unknown as Context);
  expect(await caller.status()).toEqual({ available: true });
  expect(await caller.transcribe({ audio: "test", final: false })).toEqual({
    text: "raw",
  });
  expect(await caller.polish({ text: "raw" })).toEqual({ text: "Clean." });
  expect(calls).toEqual([
    principal,
    [principal, { audio: "test", final: false }],
    [principal, { text: "raw" }],
  ]);
});
test("router refuses exhausted budgets before calling either provider", async () => {
  let providerCalls = 0;
  const keys: string[] = [];
  const limiter = {
    limit: ({ key }: { key: string }) => {
      keys.push(key);
      return Promise.resolve({ success: false });
    },
  };
  const principal = {
    kind: "user",
    userId: "u",
    via: "session",
    workspaceId: "w",
  } as const;
  const refuse = () => {
    providerCalls += 1;
    return Promise.resolve({ text: "unreachable" });
  };
  const caller = dictationRouter.createCaller({
    principal,
    services: {
      dictation: {
        polish: refuse,
        status: () => Promise.resolve({ available: true }),
        transcribe: refuse,
      },
      dictationLimits: { polish: limiter, transcribe: limiter },
    },
    userId: "u",
  } as unknown as Context);
  await expect(
    caller.transcribe({ audio: "test", final: true })
  ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  await expect(caller.polish({ text: "hello" })).rejects.toMatchObject({
    code: "TOO_MANY_REQUESTS",
  });
  expect(providerCalls).toBe(0);
  expect(keys.every((key) => key.includes("w:u"))).toBe(true);
});
