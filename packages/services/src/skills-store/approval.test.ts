import { expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import type { FileRecord, SkillRecord, VersionRecord } from "./records.ts";
import {
  A1,
  A2,
  B1,
  createSkill,
  decode,
  errorOf,
  R1,
  R2,
  R3,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

const NAME = "deploy-notes";
const SECRET = "SECRET_TOKEN_7f3a9c";

type Setup = ReturnType<typeof setup>;

/** The code a refused call fails with: a service error code, or "forbidden" for a ForbiddenError. */
const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  const caught = await errorOf(promise);
  if (caught instanceof ForbiddenError) {
    return "forbidden";
  }
  if (isServiceError(caught)) {
    return caught.code;
  }
  return `no refusal: ${String(caught)}`;
};

const contentOf = (files: readonly FileRecord[] | undefined, path: string) =>
  decode(
    files?.find((file) => file.path === path)?.content ?? new Uint8Array()
  );

const summarize = (skills: readonly SkillRecord[]) =>
  skills.map((skill) => ({
    latestApprovedVersion: skill.latestApprovedVersion,
    latestVersion: skill.latestVersion,
    name: skill.name,
    ownerAgentId: skill.ownerAgentId,
  }));

const numbersOf = (versions: readonly VersionRecord[]) =>
  versions.map((version) => version.number);

/** A commit on top of `baseVersion` that changes the body of SKILL.md. */
const edit = (
  service: Setup["service"],
  principal: Principal,
  skillId: string,
  baseVersion: number,
  text: string
) =>
  service.commit(principal, {
    baseVersion,
    message: "Edit",
    skillId,
    writes: [{ content: skillMd(NAME, text), path: "SKILL.md" }],
  });

const skillEvents = (db: Setup["db"]) =>
  db
    .select()
    .from(eventRows)
    .all()
    .filter((row) => row.type.startsWith("skill."));

const payloadOf = (payload: string | null | undefined) =>
  JSON.parse(payload ?? "{}") as Record<string, unknown>;

test("a run's create makes a skill owned by its agent, with a proposed version 1", async () => {
  const { service } = setup();
  const { skill, version } = await createSkill(service, NAME, {}, run(A1, R1));

  expect(skill.ownerAgentId).toBe(A1);
  expect(version.number).toBe(1);
  expect(version.parent).toBeNull();
  expect(version.status).toBe("proposed");
  expect(version.author).toEqual({ id: A1, kind: "agent", runId: R1 });
  expect(version.approvedBy).toBeNull();
  expect(version.approvedAt).toBeNull();
  expect(summarize(await service.list(run(A1, R1)))).toEqual([
    {
      latestApprovedVersion: null,
      latestVersion: 1,
      name: NAME,
      ownerAgentId: A1,
    },
  ]);
});

test("a run's commit makes a proposed version, and a person's commit after it is approved", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));

  const proposed = await edit(service, run(A1, R1), skill.id, 1, "Run edit.");
  expect(proposed.number).toBe(2);
  expect(proposed.parent).toBe(1);
  expect(proposed.status).toBe("proposed");
  expect(proposed.author).toEqual({ id: A1, kind: "agent", runId: R1 });

  const approved = await edit(service, user(), skill.id, 2, "Person edit.");
  expect(approved.number).toBe(3);
  expect(approved.parent).toBe(2);
  expect(approved.status).toBe("approved");
  expect(approved.approvedBy).toBe("u1");
  expect(approved.approvedAt).not.toBeNull();
  expect(approved.author).toEqual({ id: "u1", kind: "user", runId: null });
});

test("an agent that neither owns nor carries a proposed skill gets not_found for it", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  const other = run(A2, R2);

  expect(await refusalOf(service.show(other, { skillId, version: 1 }))).toBe(
    "not_found"
  );
  expect(await refusalOf(service.log(other, { skillId }))).toBe("not_found");
  expect(
    await refusalOf(service.diff(other, { from: 1, skillId, to: 1 }))
  ).toBe("not_found");
  expect(
    await refusalOf(service.exportSkillArchive(other, { skillId, version: 1 }))
  ).toBe("not_found");
  expect(await service.list(other)).toEqual([]);
});

test("a person sees a proposed skill of an agent, and a person of another workspace gets not_found", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;

  expect(summarize(await service.list(user()))).toEqual([
    {
      latestApprovedVersion: null,
      latestVersion: 1,
      name: NAME,
      ownerAgentId: A1,
    },
  ]);
  const shown = await service.show(user(), { skillId, version: 1 });
  expect(shown.version.status).toBe("proposed");
  expect(await refusalOf(service.show(user(W2), { skillId, version: 1 }))).toBe(
    "not_found"
  );
  expect(await service.list(user(W2))).toEqual([]);
});

test("the proposing run reads its own proposed version, which another agent loses once it is assigned", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;

  const own = await service.show(run(A1, R1), {
    skillId,
    version: 1,
    withContents: true,
  });
  expect(own.version.status).toBe("proposed");
  expect(contentOf(own.files, "SKILL.md")).toBe(skillMd(NAME));
  expect(numbersOf(await service.log(run(A1, R1), { skillId }))).toEqual([1]);

  await service.approve(user(), { skillId, version: 1 });
  await edit(service, run(A1, R1), skillId, 1, "Run edit.");
  await service.assign(user(), { agentId: A2, skillId });

  expect(
    await refusalOf(service.show(run(A2, R2), { skillId, version: 2 }))
  ).toBe("not_found");
  const approved = await service.show(run(A2, R2), { skillId, version: 1 });
  expect(approved.version.status).toBe("approved");
  expect(numbersOf(await service.log(run(A2, R2), { skillId }))).toEqual([1]);
  expect(summarize(await service.list(run(A2, R2)))).toEqual([
    {
      latestApprovedVersion: 1,
      latestVersion: 1,
      name: NAME,
      ownerAgentId: A1,
    },
  ]);

  const resolved = await service.forAgent(run(A2, R2), A2, {
    withContents: true,
  });
  expect(
    resolved.map((item) => ({
      name: item.name,
      pinned: item.pinned,
      version: item.version,
    }))
  ).toEqual([{ name: NAME, pinned: false, version: 1 }]);
  expect(contentOf(resolved[0]?.files, "SKILL.md")).toBe(skillMd(NAME));
});

test("a run is refused approve, reject, assign, unassign and pin, even for its own skill", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  const self = run(A1, R1);

  expect(await refusalOf(service.approve(self, { skillId, version: 1 }))).toBe(
    "forbidden"
  );
  expect(await refusalOf(service.reject(self, { skillId, version: 1 }))).toBe(
    "forbidden"
  );
  expect(await refusalOf(service.assign(self, { agentId: A2, skillId }))).toBe(
    "forbidden"
  );
  expect(
    await refusalOf(service.unassign(self, { agentId: A1, skillId }))
  ).toBe("forbidden");
  expect(
    await refusalOf(service.pin(self, { agentId: A1, skillId, version: null }))
  ).toBe("forbidden");
});

test("a run is refused a commit to a person's skill that is assigned to its agent", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, user());
  await service.assign(user(), { agentId: A1, skillId: skill.id });

  expect(
    await refusalOf(edit(service, run(A1, R1), skill.id, 1, "Run edit."))
  ).toBe("forbidden");
});

test("a run gets not_found for a commit to a skill it cannot see", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, user());

  expect(
    await refusalOf(edit(service, run(A1, R1), skill.id, 1, "Run edit."))
  ).toBe("not_found");
});

test("a run is refused the skills of another agent", async () => {
  const { service } = setup();
  await createSkill(service, NAME, {}, run(A1, R1));

  expect(await refusalOf(service.forAgent(run(A1, R1), A2))).toBe("forbidden");
});

test("a run from another workspace cannot read or commit to this workspace's skills", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, user());
  const skillId = skill.id;
  const outsider = run(B1, R3, W2);

  expect(await refusalOf(service.show(outsider, { skillId, version: 1 }))).toBe(
    "not_found"
  );
  expect(
    await refusalOf(edit(service, outsider, skillId, 1, "Outsider edit."))
  ).toBe("not_found");
  expect(await service.list(outsider)).toEqual([]);
});

test("a person approves a proposed version, and the agent it is assigned to resolves it", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.assign(user(), { agentId: A2, skillId });

  const approved = await service.approve(user(), { skillId, version: 1 });
  expect(approved.status).toBe("approved");
  expect(approved.approvedBy).toBe("u1");
  expect(approved.approvedAt).not.toBeNull();

  const resolved = await service.forAgent(user(), A2);
  expect(
    resolved.map((item) => ({ name: item.name, version: item.version }))
  ).toEqual([{ name: NAME, version: 1 }]);
});

test("a person rejects a proposed version, and an agent never resolves it", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.assign(user(), { agentId: A2, skillId });

  const rejected = await service.reject(user(), { skillId, version: 1 });
  expect(rejected.status).toBe("rejected");
  expect(await service.forAgent(user(), A2)).toEqual([]);
  expect(
    (await service.log(user(), { skillId })).map((item) => item.status)
  ).toEqual(["rejected"]);
});

test("approving or rejecting a version that is not proposed is a conflict", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, user());
  const skillId = skill.id;

  expect(
    await refusalOf(service.approve(user(), { skillId, version: 1 }))
  ).toBe("conflict");
  expect(await refusalOf(service.reject(user(), { skillId, version: 1 }))).toBe(
    "conflict"
  );
});

test("approving or rejecting an unknown version is not found", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;

  expect(
    await refusalOf(service.approve(user(), { skillId, version: 9 }))
  ).toBe("not_found");
  expect(await refusalOf(service.reject(user(), { skillId, version: 9 }))).toBe(
    "not_found"
  );
});

test("approving a proposal whose base is no longer the latest approved version is a conflict", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.approve(user(), { skillId, version: 1 });
  await edit(service, run(A1, R1), skillId, 1, "Run edit.");
  await edit(service, user(), skillId, 2, "Person edit.");

  expect(
    await refusalOf(service.approve(user(), { skillId, version: 2 }))
  ).toBe("conflict");
});

test("chained proposals are approved in order, not out of order", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.approve(user(), { skillId, version: 1 });
  await edit(service, run(A1, R1), skillId, 1, "First run edit.");
  await edit(service, run(A1, R1), skillId, 2, "Second run edit.");

  expect(
    await refusalOf(service.approve(user(), { skillId, version: 3 }))
  ).toBe("conflict");
  const second = await service.approve(user(), { skillId, version: 2 });
  expect(second.status).toBe("approved");
  const third = await service.approve(user(), { skillId, version: 3 });
  expect(third.status).toBe("approved");
});

test("the first version a run proposes can be approved while nothing else is approved", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));

  const approved = await service.approve(user(), {
    skillId: skill.id,
    version: 1,
  });
  expect(approved.status).toBe("approved");
  expect(approved.parent).toBeNull();
});

test("after a rejection the next commit is made on version 1", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.approve(user(), { skillId, version: 1 });
  await edit(service, run(A1, R1), skillId, 1, "Run edit.");
  await service.reject(user(), { skillId, version: 2 });

  expect(
    await refusalOf(edit(service, user(), skillId, 2, "Stale edit."))
  ).toBe("conflict");
  const next = await edit(service, user(), skillId, 1, "After reject.");
  expect(next.number).toBe(3);
  expect(next.parent).toBe(1);
  expect(next.status).toBe("approved");
  expect(
    (await service.log(user(), { skillId })).map((item) => [
      item.number,
      item.status,
    ])
  ).toEqual([
    [3, "approved"],
    [2, "rejected"],
    [1, "approved"],
  ]);
});

test("each write records its skill events, with the principal as the actor", async () => {
  const { db, service } = setup();
  const { skill } = await createSkill(service, NAME, {}, run(A1, R1));
  const skillId = skill.id;
  await service.approve(user(), { skillId, version: 1 });
  await edit(service, run(A1, R1), skillId, 1, "Run edit.");
  await service.reject(user(), { skillId, version: 2 });
  await edit(service, user(), skillId, 1, "After reject.");
  await service.assign(user(), { agentId: A2, skillId });
  await service.pin(user(), { agentId: A2, skillId, version: 1 });
  await service.unassign(user(), { agentId: A2, skillId });

  const rows = skillEvents(db);
  expect(
    rows.map((row) => `${row.type} ${row.actorKind} ${row.actorId}`)
  ).toEqual([
    "skill.created agent a1",
    "skill.assigned agent a1",
    "skill.approved user u1",
    "skill.committed agent a1",
    "skill.rejected user u1",
    "skill.committed user u1",
    "skill.assigned user u1",
    "skill.pinned user u1",
    "skill.unassigned user u1",
  ]);

  const [
    created,
    autoAssigned,
    approvedRow,
    runCommit,
    rejected,
    personCommit,
  ] = rows;
  expect(autoAssigned?.agentId).toBe(A1);
  expect(autoAssigned?.runId).toBe(R1);
  expect(created?.agentId).toBe(A1);
  expect(created?.runId).toBe(R1);
  expect(payloadOf(created?.payload)).toEqual({
    name: NAME,
    skillId,
    status: "proposed",
    version: 1,
  });
  expect(runCommit?.agentId).toBe(A1);
  expect(runCommit?.runId).toBe(R1);
  expect(payloadOf(runCommit?.payload)).toEqual({
    name: NAME,
    skillId,
    status: "proposed",
    version: 2,
  });
  expect(payloadOf(approvedRow?.payload)).toEqual({
    name: NAME,
    skillId,
    version: 1,
  });
  expect(payloadOf(rejected?.payload)).toEqual({
    name: NAME,
    skillId,
    version: 2,
  });
  expect(payloadOf(personCommit?.payload)).toEqual({
    name: NAME,
    skillId,
    status: "approved",
    version: 3,
  });
});

test("no event payload carries file contents", async () => {
  const { blobs, db, service } = setup();
  const { skill } = await createSkill(
    service,
    NAME,
    { "notes.md": `token: ${SECRET}\n` },
    run(A1, R1)
  );
  await edit(service, user(), skill.id, 1, `Use ${SECRET}.`);

  expect([...blobs.objects.values()].map(decode).join("\n")).toContain(SECRET);
  const payloads = skillEvents(db).map((row) => row.payload ?? "");
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.join("\n")).not.toContain(SECRET);
});
