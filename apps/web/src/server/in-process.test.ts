import { expect, test } from "bun:test";
import { inProcessFetch, setInProcessDispatch } from "./in-process.ts";

const env = { PUBLIC_BASE_URL: "https://hm.test" } as unknown as Env;

test("nothing is dispatched until the app has handed over its fetch", () => {
  expect(inProcessFetch(env)).toBeUndefined();
});

test("a request goes to the app with the bindings and a context that keeps work alive", async () => {
  const kept: Promise<void>[] = [];
  const seen: { env: Env; url: string }[] = [];
  setInProcessDispatch((request, bindings, ctx) => {
    seen.push({ env: bindings, url: request.url });
    ctx.waitUntil(Promise.reject(new Error("late failure")));
    return new Response("ok");
  });

  const send = inProcessFetch(env, (work) => kept.push(work));
  const response = await send?.(new Request("https://hm.test/a2a/x"));

  expect(await response?.text()).toBe("ok");
  expect(seen).toEqual([{ env, url: "https://hm.test/a2a/x" }]);
  // Work the request left behind is kept alive, and its failure does not escape.
  expect(kept).toHaveLength(1);
  await expect(kept[0]).resolves.toBeUndefined();
});
