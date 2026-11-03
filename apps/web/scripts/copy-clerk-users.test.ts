import { describe, expect, test } from "bun:test";
import {
  missingMembers,
  planCopy,
  type SourceOrg,
  type SourceUser,
} from "./copy-clerk-users-helpers.ts";

const user = (id: string, email: string): SourceUser => ({
  email,
  firstName: null,
  id,
  lastName: null,
});

const ann = user("user_ann", "Ann@Example.com");
const bob = user("user_bob", "bob@example.com");

const org = (overrides: Partial<SourceOrg>): SourceOrg => ({
  createdBy: "user_ann",
  id: "org_one",
  members: [
    { role: "org:admin", userId: "user_ann" },
    { role: "org:member", userId: "user_bob" },
  ],
  name: "One",
  ...overrides,
});

describe("planCopy", () => {
  test("lists each person once, lower-cased and sorted by email", () => {
    const plan = planCopy(
      [org({}), org({ id: "org_two", name: "Two" })],
      [bob, ann]
    );
    expect(plan.people.map((person) => person.email)).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);
    expect(plan.orgs.map((o) => o.oldId)).toEqual(["org_one", "org_two"]);
  });

  test("the old creator creates the org when still an admin", () => {
    expect(planCopy([org({})], [ann, bob]).orgs[0]?.creatorOldId).toBe(
      "user_ann"
    );
  });

  test("falls back to the first admin, then the first member", () => {
    const noCreator = org({
      createdBy: "user_gone",
      members: [
        { role: "org:member", userId: "user_ann" },
        { role: "org:admin", userId: "user_bob" },
      ],
    });
    expect(planCopy([noCreator], [ann, bob]).orgs[0]?.creatorOldId).toBe(
      "user_bob"
    );
    const noAdmin = org({
      createdBy: null,
      members: [{ role: "org:member", userId: "user_bob" }],
    });
    expect(planCopy([noAdmin], [bob]).orgs[0]?.creatorOldId).toBe("user_bob");
  });

  test("refuses an org with no members", () => {
    expect(() => planCopy([org({ members: [] })], [])).toThrow(
      "has no members"
    );
  });

  test("refuses a member without a user record", () => {
    expect(() => planCopy([org({})], [ann])).toThrow("user_bob");
  });

  test("refuses two orgs with the same name", () => {
    expect(() =>
      planCopy([org({}), org({ id: "org_two" })], [ann, bob])
    ).toThrow('Two organisations are named "One"');
  });
});

describe("missingMembers", () => {
  const plan = planCopy([org({})], [ann, bob]);
  const newIdOf = (oldId: string) => oldId.replace("user_", "new_");

  test("skips members already on the new org", () => {
    const [first] = plan.orgs;
    if (first === undefined) {
      throw new Error("no org");
    }
    expect(missingMembers(first, newIdOf, new Set(["new_ann"]))).toEqual([
      { role: "org:member", userId: "new_bob" },
    ]);
    expect(
      missingMembers(first, newIdOf, new Set(["new_ann", "new_bob"]))
    ).toEqual([]);
  });
});
