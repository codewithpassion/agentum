import { expect, test } from "bun:test";
import { cachedOrgMemberCheck } from "./clerk-membership.ts";

test("reuses an answer for the ttl, per user and organisation, true and false alike", async () => {
  let now = 0;
  let calls = 0;
  const check = cachedOrgMemberCheck(
    (userId) => {
      calls += 1;
      return Promise.resolve(userId === "u1");
    },
    { now: () => now, ttlMs: 1000 }
  );
  expect(await check("u1", "org_a")).toBe(true);
  expect(await check("u1", "org_a")).toBe(true);
  expect(await check("u2", "org_a")).toBe(false);
  expect(await check("u2", "org_a")).toBe(false);
  expect(calls).toBe(2);

  now = 1001;
  await check("u1", "org_a");
  expect(calls).toBe(3);
});

test("does not keep an error", async () => {
  let calls = 0;
  const check = cachedOrgMemberCheck(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("outage"))
      : Promise.resolve(true);
  });
  await expect(check("u1", "org_a")).rejects.toThrow("outage");
  expect(await check("u1", "org_a")).toBe(true);
});
