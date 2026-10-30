import { describe, expect, test } from "bun:test";
import type { WorkspaceMember } from "@repo/db/shared";
import {
  backupChoices,
  canPick,
  effectiveOwner,
  nextOwners,
} from "./asks-logic.ts";

const ada: WorkspaceMember = { name: "Ada", userId: "user_a" };
const ben: WorkspaceMember = { name: "Ben", userId: "user_b" };
const cy: WorkspaceMember = { name: "Cy", userId: "user_c" };
const everyone = [ada, ben, cy];

describe("effectiveOwner", () => {
  test.each([
    [
      "an explicit owner who is a member",
      { createdBy: "user_a", ownerUserId: "user_b" },
      everyone,
      ben,
    ],
    [
      "a null owner falls back to the creator",
      { createdBy: "user_c", ownerUserId: null },
      everyone,
      cy,
    ],
    [
      "an owner who left the organisation",
      { createdBy: "user_a", ownerUserId: "user_gone" },
      everyone,
      null,
    ],
    [
      "a null owner whose creator left",
      { createdBy: "user_gone", ownerUserId: null },
      everyone,
      null,
    ],
    [
      "an empty member list",
      { createdBy: "user_a", ownerUserId: null },
      [],
      null,
    ],
  ])("%s", (_name, agent, members, expected) => {
    expect(effectiveOwner(agent, members)).toEqual(expected);
  });
});

describe("backupChoices", () => {
  test.each([
    ["excludes the owner", everyone, "user_b", [ada, cy]],
    [
      "keeps everyone when the owner is not a member",
      everyone,
      "user_gone",
      everyone,
    ],
    ["is empty when the owner is the only member", [ada], "user_a", []],
  ])("%s", (_name, members, owner, expected) => {
    expect(backupChoices(members, owner)).toEqual(expected);
  });
});

describe("canPick", () => {
  test.each([
    ["no members", [], false],
    ["one member", [ada], false],
    ["two members", [ada, ben], true],
    ["three members", everyone, true],
  ])("%s", (_name, members, expected) => {
    expect(canPick(members)).toBe(expected);
  });
});

describe("nextOwners", () => {
  const current = { backupUserId: "user_c", ownerUserId: "user_a" };

  test.each([
    [
      "an owner change keeps a backup that is still different",
      { ownerUserId: "user_b" },
      { backupUserId: "user_c", ownerUserId: "user_b" },
    ],
    [
      "an owner change to the current backup clears the backup",
      { ownerUserId: "user_c" },
      { backupUserId: null, ownerUserId: "user_c" },
    ],
    [
      "a backup change sets the backup and keeps the owner",
      { backupUserId: "user_b" },
      { backupUserId: "user_b", ownerUserId: "user_a" },
    ],
    [
      "a backup change to no backup",
      { backupUserId: null },
      { backupUserId: null, ownerUserId: "user_a" },
    ],
    [
      "a backup change to the owner is refused",
      { backupUserId: "user_a" },
      { backupUserId: null, ownerUserId: "user_a" },
    ],
    [
      "a backup change to someone outside the list is refused",
      { backupUserId: "user_gone" },
      { backupUserId: null, ownerUserId: "user_a" },
    ],
  ])("%s", (_name, change, expected) => {
    expect(nextOwners({ change, current, members: everyone })).toEqual(
      expected
    );
  });

  test("never produces a backup equal to the owner, for any pick", () => {
    const owners = everyone.map((member) => member.userId);
    const backups: (string | null)[] = [null, ...owners];
    for (const owner of owners) {
      for (const backup of backups) {
        const fromOwner = nextOwners({
          change: { ownerUserId: owner },
          current: { backupUserId: backup, ownerUserId: "user_a" },
          members: everyone,
        });
        const fromBackup = nextOwners({
          change: { backupUserId: backup },
          current: { backupUserId: null, ownerUserId: owner },
          members: everyone,
        });
        expect(fromOwner.backupUserId).not.toBe(fromOwner.ownerUserId);
        expect(fromBackup.backupUserId).not.toBe(fromBackup.ownerUserId);
      }
    }
  });
});
