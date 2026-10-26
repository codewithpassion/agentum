/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createUnloadSafeFetch } from "./unload-safe-fetch.ts";

const setup = (base: () => Promise<Response>) => {
  const listeners = new Map<string, () => void>();
  const page = {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, listener);
    },
  };
  const safeFetch = createUnloadSafeFetch(page, base);
  const fire = (type: string) => listeners.get(type)?.();
  return { fire, safeFetch };
};

const failing = () => Promise.reject(new TypeError("Failed to fetch"));
const pending = Symbol("pending");
const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 20)),
  ]);

describe("createUnloadSafeFetch", () => {
  test("returns the response of a successful request", async () => {
    const response = new Response("ok");
    const { safeFetch } = setup(() => Promise.resolve(response));
    expect(await safeFetch("/x")).toBe(response);
  });

  test("rethrows a failed request while the page is live", async () => {
    const { safeFetch } = setup(failing);
    expect(await settled(safeFetch("/x"))).toBe("rejected");
  });

  test("keeps a failed request pending once the page is hiding", async () => {
    const { fire, safeFetch } = setup(failing);
    fire("pagehide");
    expect(await settled(safeFetch("/x"))).toBe(pending);
  });

  test("rethrows again after the page is restored", async () => {
    const { fire, safeFetch } = setup(failing);
    fire("pagehide");
    fire("pageshow");
    expect(await settled(safeFetch("/x"))).toBe("rejected");
  });
});
