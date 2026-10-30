/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued effects and promises. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { usePolledQuery } from "./use-polled-query.ts";

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];
beforeAll(() => {
  for (const key of KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const mount = async (
  load: () => Promise<number>,
  intervalMs: number,
  seen: { data: number | null; error: string | null }
) => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  function Probe() {
    const { data, error } = usePolledQuery(load, null, intervalMs);
    seen.data = data;
    seen.error = error;
    return null;
  }
  await act(async () => root.render(<Probe />));
  return () => act(async () => root.unmount());
};

test("a load slower than the poll interval still lands", async () => {
  const seen = { data: null as number | null, error: null as string | null };
  let started = 0;
  const unmount = await mount(
    async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return started;
    },
    20,
    seen
  );
  await wait(200);
  expect(seen.data).not.toBeNull();
  await unmount();
});

test("a failing load slower than the poll interval still reports its error", async () => {
  const seen = { data: null as number | null, error: null as string | null };
  const unmount = await mount(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("boom");
    },
    20,
    seen
  );
  await wait(200);
  expect(seen.error).toBe("boom");
  await unmount();
});
