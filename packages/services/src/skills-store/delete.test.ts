import { describe, expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import {
  skillAssignments,
  skills,
  skillVersionFiles,
  skillVersions,
} from "@repo/db/schema/skills";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import {
  A1,
  A2,
  createSkill,
  errorOf,
  R1,
  R2,
  run,
  setup,
  skillMd,
  user,
} from "./test-support.ts";

type Setup = ReturnType<typeof setup>;

/** Every seeded run is running. This finishes them so a delete is not blocked. */
const finishRuns = (db: Setup["db"]) =>
  db.update(runRows).set({ status: "done" }).run();

const countOf = (db: Setup["db"], skillId: string) => ({
  assignments: db
    .select()
    .from(skillAssignments)
    .where(eq(skillAssignments.skillId, skillId))
    .all().length,
  files: db.select().from(skillVersionFiles).all().length,
  skill: db.select().from(skills).where(eq(skills.id, skillId)).all().length,
  versions: db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .all().length,
});

describe("deleting a skill", () => {
  test("removes the skill, its versions, files and assignments, and records an event", async () => {
    const { db, service } = setup();
    finishRuns(db);
    const { skill } = await createSkill(service, "doomed", { "a.txt": "a" });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await service.assign(user(), { agentId: A2, skillId: skill.id });
    await service.remove(user(), { skillId: skill.id });
    expect(countOf(db, skill.id)).toEqual({
      assignments: 0,
      files: 0,
      skill: 0,
      versions: 0,
    });
    const logged = db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "skill.deleted"))
      .all();
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]?.payload ?? "null")).toEqual({
      name: "doomed",
      skillId: skill.id,
    });
    expect(await service.list(user())).toEqual([]);
  });

  test("frees the name for a new skill", async () => {
    const { db, service } = setup();
    finishRuns(db);
    const { skill } = await createSkill(service, "again");
    await service.remove(user(), { skillId: skill.id });
    const next = await createSkill(service, "again");
    expect(next.skill.id).not.toBe(skill.id);
  });

  test("removes blobs no other version holds and keeps shared ones", async () => {
    const { blobs, db, service } = setup();
    finishRuns(db);
    const first = await createSkill(service, "first", {
      "only.txt": "only first",
      "shared.txt": "shared bytes",
    });
    await createSkill(service, "second", { "shared.txt": "shared bytes" });
    const before = blobs.objects.size;
    await service.remove(user(), { skillId: first.skill.id });
    // The SKILL.md of "first" and its own file go. "shared bytes" stays for "second".
    expect(blobs.objects.size).toBe(before - 2);
    const keys = [...blobs.objects.keys()];
    const shared = keys.filter(
      (key) =>
        new TextDecoder().decode(blobs.objects.get(key)) === "shared bytes"
    );
    expect(shared).toHaveLength(1);
    const only = keys.filter(
      (key) => new TextDecoder().decode(blobs.objects.get(key)) === "only first"
    );
    expect(only).toHaveLength(0);
  });

  test("is refused while a run of an agent that carries the skill is live", async () => {
    const { db, service } = setup();
    finishRuns(db);
    const { skill } = await createSkill(service, "busy");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    db.update(runRows)
      .set({ status: "waiting" })
      .where(eq(runRows.id, R1))
      .run();
    const error = await errorOf(service.remove(user(), { skillId: skill.id }));
    expect(isServiceError(error) && error.code).toBe("conflict");
    expect(countOf(db, skill.id).skill).toBe(1);
    db.update(runRows).set({ status: "done" }).where(eq(runRows.id, R1)).run();
    await service.remove(user(), { skillId: skill.id });
    expect(countOf(db, skill.id).skill).toBe(0);
  });

  test("a live run of an agent that does not carry the skill does not block it", async () => {
    const { db, service } = setup();
    finishRuns(db);
    const { skill } = await createSkill(service, "elsewhere");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    db.update(runRows)
      .set({ status: "running" })
      .where(eq(runRows.id, R2))
      .run();
    await service.remove(user(), { skillId: skill.id });
    expect(countOf(db, skill.id).skill).toBe(0);
  });

  test("a run is refused", async () => {
    const { db, service } = setup();
    finishRuns(db);
    const { skill } = await createSkill(service, "mine");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect(
      await errorOf(service.remove(run(A1, R1), { skillId: skill.id }))
    ).toBeInstanceOf(ForbiddenError);
  });

  test("another workspace gets not_found", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "private");
    const error = await errorOf(
      service.remove(user("w2"), { skillId: skill.id })
    );
    expect(isServiceError(error) && error.code).toBe("not_found");
  });
});

describe("a skill an agent creates", () => {
  const draft = (service: Setup["service"], name: string) =>
    service.create(run(A1, R1), {
      files: [{ content: skillMd(name), path: "SKILL.md" }],
      message: "Draft",
      name,
    });

  test("is assigned to its owner, following the latest approved version", async () => {
    const { db, service } = setup();
    const { skill } = await draft(service, "own-draft");
    const rows = db
      .select()
      .from(skillAssignments)
      .where(eq(skillAssignments.skillId, skill.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: A1, pinnedVersionId: null });
    const logged = db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "skill.assigned"))
      .all();
    expect(logged.map((row) => row.agentId)).toEqual([A1]);
  });

  test("reaches the agent's runs once a person approves a version", async () => {
    const { service } = setup();
    const { skill } = await draft(service, "arrives");
    expect(await service.forAgent(run(A1, R1), A1)).toEqual([]);
    await service.approve(user(), { skillId: skill.id, version: 1 });
    const resolved = await service.forAgent(run(A1, R1), A1);
    expect(resolved.map((entry) => entry.name)).toEqual(["arrives"]);
  });

  test("is not assigned when the agent already carries a skill of that name", async () => {
    const { db, service } = setup();
    const shared = await createSkill(service, "same-name");
    await service.assign(user(), { agentId: A1, skillId: shared.skill.id });
    const { skill } = await draft(service, "same-name");
    expect(countOf(db, skill.id).assignments).toBe(0);
  });

  test("a skill a person creates is not assigned to anyone", async () => {
    const { db, service } = setup();
    const { skill } = await createSkill(service, "people-owned");
    expect(countOf(db, skill.id).assignments).toBe(0);
  });
});
