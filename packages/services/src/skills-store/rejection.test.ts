import { beforeEach, expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { eq } from "drizzle-orm";
import { isServiceError } from "../errors.ts";
import {
  A1,
  createSkill,
  errorOf,
  R1,
  run,
  setup,
  skillMd,
  user,
} from "./test-support.ts";

let env: ReturnType<typeof setup>;

const write = (name: string, body: string) => ({
  content: skillMd(name, body),
  path: "SKILL.md",
});

beforeEach(() => {
  env = setup();
});

test("a skill whose only version was rejected takes a fresh start a person can approve", async () => {
  const { service } = env;
  const { skill } = await service.create(run(A1, R1), {
    files: [write("foo", "one")],
    message: "Propose",
    name: "foo",
  });
  await service.reject(user(), { skillId: skill.id, version: 1 });

  const again = await service.commit(run(A1, R1), {
    baseVersion: 1,
    message: "Try again",
    skillId: skill.id,
    writes: [write("foo", "two")],
  });

  expect(again).toMatchObject({ number: 2, parent: null, status: "proposed" });
  const shown = await service.show(run(A1, R1), {
    skillId: skill.id,
    version: 2,
  });
  expect(shown.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  const approved = await service.approve(user(), {
    skillId: skill.id,
    version: 2,
  });
  expect(approved.status).toBe("approved");
});

test("rejecting a proposal rejects the proposals built on it, writes an event for each, and the next commit starts from the last good version", async () => {
  const { db, service } = env;
  const { skill } = await service.create(run(A1, R1), {
    files: [write("bar", "one")],
    message: "v1",
    name: "bar",
  });
  await service.approve(user(), { skillId: skill.id, version: 1 });
  await service.commit(run(A1, R1), {
    baseVersion: 1,
    message: "v2",
    skillId: skill.id,
    writes: [write("bar", "two")],
  });
  await service.commit(run(A1, R1), {
    baseVersion: 2,
    message: "v3",
    skillId: skill.id,
    writes: [write("bar", "three")],
  });

  await service.reject(user(), { skillId: skill.id, version: 2 });

  const log = await service.log(user(), { skillId: skill.id });
  expect(log.map((version) => [version.number, version.status])).toEqual([
    [3, "rejected"],
    [2, "rejected"],
    [1, "approved"],
  ]);
  const rejected = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "skill.rejected"))
    .all()
    .map((event) => JSON.parse(event.payload ?? "{}"))
    .sort((left, right) => left.version - right.version);
  expect(rejected).toMatchObject([
    { skillId: skill.id, version: 2 },
    { rejectedWith: 2, skillId: skill.id, version: 3 },
  ]);
  const next = await service.commit(run(A1, R1), {
    baseVersion: 1,
    message: "v4",
    skillId: skill.id,
    writes: [write("bar", "four")],
  });
  expect(next).toMatchObject({ number: 4, parent: 1 });
});

test("a commit that writes the same path twice is invalid", async () => {
  const { service } = env;
  const { skill } = await createSkill(service, "dup-writes");

  const error = await errorOf(
    service.commit(user(), {
      baseVersion: 1,
      message: "Twice",
      skillId: skill.id,
      writes: [write("dup-writes", "a"), write("dup-writes", "b")],
    })
  );

  expect(isServiceError(error) && error.code).toBe("invalid");
  expect(error).toHaveProperty(
    "message",
    'Skill path "SKILL.md" appears twice'
  );
});

test("a commit that deletes the same path twice is invalid", async () => {
  const { service } = env;
  const { skill } = await createSkill(service, "dup-deletes", {
    "notes.md": "x",
  });

  const error = await errorOf(
    service.commit(user(), {
      baseVersion: 1,
      deletes: [{ path: "notes.md" }, { path: "notes.md" }],
      message: "Twice",
      skillId: skill.id,
    })
  );

  expect(error).toHaveProperty(
    "message",
    'Skill path "notes.md" appears twice'
  );
});
