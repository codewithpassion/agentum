import { expect, test } from "bun:test";
import { cachedOrgMemberCheck, cachedUserOrgIds } from "./clerk-membership.ts";

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

test("a user's org list is reused for 60 seconds per user, then fetched again", async () => {
  let now = 0;
  let calls = 0;
  const orgs = cachedUserOrgIds(
    (userId) => {
      calls += 1;
      return Promise.resolve([`org_of_${userId}`]);
    },
    { now: () => now }
  );
  expect(await orgs("u1")).toEqual(["org_of_u1"]);
  now = 59_999;
  expect(await orgs("u1")).toEqual(["org_of_u1"]);
  expect(calls).toBe(1);

  expect(await orgs("u2")).toEqual(["org_of_u2"]);
  expect(calls).toBe(2);

  now = 60_001;
  await orgs("u1");
  expect(calls).toBe(3);
});

test("an org list keeps neither an error nor an empty answer", async () => {
  let calls = 0;
  const orgs = cachedUserOrgIds(() => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("outage"));
    }
    return Promise.resolve(calls === 2 ? [] : ["org_a"]);
  });
  await expect(orgs("u1")).rejects.toThrow("outage");
  expect(await orgs("u1")).toEqual([]);
  expect(await orgs("u1")).toEqual(["org_a"]);
  expect(await orgs("u1")).toEqual(["org_a"]);
  expect(calls).toBe(3);
});
