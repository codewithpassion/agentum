import { expect, test } from "bun:test";
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, nextBackoffMs } from "./backoff.ts";

test("stays inside one second to one minute at every attempt", () => {
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delay = nextBackoffMs(attempt, random);
      expect(delay).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  }
});

test("doubles until it reaches the cap", () => {
  const mid = () => 0.5;
  expect(nextBackoffMs(0, mid)).toBe(1000);
  expect(nextBackoffMs(1, mid)).toBe(2000);
  expect(nextBackoffMs(2, mid)).toBe(4000);
  expect(nextBackoffMs(20, mid)).toBe(MAX_BACKOFF_MS);
});

test("spreads reconnects apart with jitter", () => {
  expect(nextBackoffMs(4, () => 0)).not.toBe(nextBackoffMs(4, () => 1));
});
