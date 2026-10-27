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
