/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { soleWorkspaceOrgId } from "./sole-organization.ts";

const row = (clerkOrgId: string) => ({ clerkOrgId });

describe("soleWorkspaceOrgId", () => {
  test("returns the id of the only workspace", () => {
    expect(soleWorkspaceOrgId([row("org_a")])).toBe("org_a");
  });

  test("returns undefined while the list has not loaded", () => {
    expect(soleWorkspaceOrgId(undefined)).toBeUndefined();
  });

  test("returns undefined when the person has no workspace", () => {
    expect(soleWorkspaceOrgId([])).toBeUndefined();
  });

  test("returns undefined when the person has two workspaces", () => {
    expect(soleWorkspaceOrgId([row("org_a"), row("org_b")])).toBeUndefined();
  });
});
