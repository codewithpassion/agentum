import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { dictationRouter, dictationWithinLimit } from "./dictation-router.ts";

test("all procedures reject a non-member", async () => {
  const caller = dictationRouter.createCaller({
    principal: null,
    services: {},
    userId: null,
  } as Context);
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
