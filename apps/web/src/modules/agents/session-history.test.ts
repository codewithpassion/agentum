import { describe, expect, test } from "bun:test";
import { settleWithin } from "./session-history";

describe("settleWithin", () => {
  test("returns once the work is done, without waiting out the budget", async () => {
    const started = Date.now();
    await settleWithin(Promise.resolve("done"), 5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("gives up on work that outlasts the budget", async () => {
    const never = new Promise<void>(() => undefined);
    const started = Date.now();
    await settleWithin(never, 30);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
