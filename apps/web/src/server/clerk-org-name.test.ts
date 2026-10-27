import { expect, test } from "bun:test";
import { cachedOrgName } from "./clerk-org-name.ts";

test("cachedOrgName trims the name, reuses it, and asks again after the TTL", async () => {
  let calls = 0;
  let clock = 0;
  const lookup = cachedOrgName(
    {
      getOrganization: () => {
        calls += 1;
        return Promise.resolve({ name: "  Acme  " });
      },
    },
    () => clock
  );
  expect(await lookup("org_a")).toBe("Acme");
  expect(await lookup("org_a")).toBe("Acme");
  expect(calls).toBe(1);
  clock = 300_001;
  await lookup("org_a");
  expect(calls).toBe(2);
});

test("cachedOrgName answers null for a blank name and does not cache an error", async () => {
  const blank = cachedOrgName({
    getOrganization: () => Promise.resolve({ name: " " }),
  });
  expect(await blank("org_a")).toBeNull();
  const answers = [
    () => Promise.reject(new Error("down")),
    () => Promise.resolve({ name: "A" }),
  ];
  const flaky = cachedOrgName({
    getOrganization: () =>
      (answers.shift() as () => Promise<{ name: string }>)(),
  });
  await expect(flaky("org_a")).rejects.toThrow("down");
  expect(await flaky("org_a")).toBe("A");
});
