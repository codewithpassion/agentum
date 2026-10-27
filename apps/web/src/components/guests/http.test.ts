import { expect, test } from "bun:test";
import { GuestHttp } from "./http";

test("guest queue preserves admission barrier and continues after refusal", async () => {
  const http = new GuestHttp();
  const order: string[] = [];
  let admit: (() => void) | undefined;
  const upgrade = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const join = http.run(async () => {
    order.push("join-cookie");
    await upgrade;
    order.push("socket-admitted");
  });
  const policy = http.run(() => {
    order.push("policy-cookie");
    return Promise.resolve();
  });
  await Promise.resolve();
  expect(order).toEqual(["join-cookie"]);
  admit?.();
  await Promise.all([join, policy]);
  expect(order).toEqual(["join-cookie", "socket-admitted", "policy-cookie"]);
  await expect(
    http.run(() => Promise.reject(new Error("refused")))
  ).rejects.toThrow("refused");
  expect(await http.run(() => Promise.resolve("next"))).toBe("next");
});

test("guest refusal disposes its body before releasing the rotating-cookie queue", async () => {
  const { spyOn } = await import("bun:test");
  const http = new GuestHttp();
  const order: string[] = [];
  let release!: () => void;
  const disposed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                order.push("cancel");
                return disposed;
              },
            }),
            { status: 404 }
          )
        ),
      { preconnect: globalThis.fetch.preconnect }
    )
  );
  try {
    const refusal = http.json(
      "/api/guest/artifacts/fixture/decide-suggestion",
      {}
    );
    const next = http.run(() => {
      order.push("next");
      return Promise.resolve("rotated");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["cancel"]);
    release();
    await expect(refusal).rejects.toThrow("This invite has ended");
    expect(await next).toBe("rotated");
    expect(order).toEqual(["cancel", "next"]);
  } finally {
    release();
    fetcher.mockRestore();
  }
});
