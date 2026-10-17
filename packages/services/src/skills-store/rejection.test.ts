import { beforeEach, expect, test } from "bun:test";
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
  const approved = await service.approve(user(), {
    skillId: skill.id,
    version: 2,
  });
  expect(approved.status).toBe("approved");
});

test("rejecting a proposal rejects the proposals built on it and the next commit starts from the last good version", async () => {
  const { service } = env;
  const { skill } = await createSkill(service, "bar");
  await service.create(run(A1, R1), {
    files: [write("bar-agent", "x")],
    message: "unrelated",
    name: "bar-agent",
  });
  const own = await service.commit(user(), {
    baseVersion: 1,
    message: "Approved v2",
    skillId: skill.id,
    writes: [write("bar", "two")],
  });
  expect(own.number).toBe(2);
  const agentSkill = (await service.list(run(A1, R1))).find(
    (item) => item.name === "bar-agent"
  );
  const id = agentSkill?.id ?? "";
  await service.commit(run(A1, R1), {
    baseVersion: 1,
    message: "v2",
    skillId: id,
    writes: [write("bar-agent", "y")],
  });
  await service.commit(run(A1, R1), {
    baseVersion: 2,
    message: "v3",
    skillId: id,
    writes: [write("bar-agent", "z")],
  });

  await service.reject(user(), { skillId: id, version: 2 });

  const log = await service.log(user(), { skillId: id });
  expect(log.map((version) => [version.number, version.status])).toEqual([
    [3, "rejected"],
    [2, "rejected"],
    [1, "proposed"],
  ]);
  const next = await service.commit(run(A1, R1), {
    baseVersion: 1,
    message: "v4",
    skillId: id,
    writes: [write("bar-agent", "w")],
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
});
