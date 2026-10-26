/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { soleOrganizationId } from "./sole-organization.ts";

const membership = (id: string) => ({ organization: { id } });

describe("soleOrganizationId", () => {
  test("returns the id of the only membership when data and count are both one", () => {
    expect(soleOrganizationId([membership("org_a")], 1)).toBe("org_a");
  });

  test("returns undefined when data is undefined", () => {
    expect(soleOrganizationId(undefined, 1)).toBeUndefined();
  });

  test("returns undefined when count is undefined", () => {
    expect(
      soleOrganizationId([membership("org_a")], undefined)
    ).toBeUndefined();
  });

  test("returns undefined when the user has no memberships", () => {
    expect(soleOrganizationId([], 0)).toBeUndefined();
  });

  test("returns undefined when the user has two memberships", () => {
    expect(
      soleOrganizationId([membership("org_a"), membership("org_b")], 2)
    ).toBeUndefined();
  });

  test("returns undefined when count disagrees with a single loaded item", () => {
    expect(soleOrganizationId([membership("org_a")], 2)).toBeUndefined();
  });

  test("returns undefined when count is one but data holds two items", () => {
    expect(
      soleOrganizationId([membership("org_a"), membership("org_b")], 1)
    ).toBeUndefined();
  });
});
