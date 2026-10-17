import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { events as eventRows } from "@repo/db/schema/events";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import {
  A1,
  A2,
  B1,
  bytes,
  createSkill,
  errorOf,
  R1,
  readOnlyUser,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

type Setup = ReturnType<typeof setup>;
type Service = Setup["service"];

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** The file list entry a file with this text content should have. */
const fileRecord = (path: string, content: string, executable = false) => ({
  executable,
  hash: sha256(content),
  path,
  size: bytes(content).byteLength,
});

/** The code of the ServiceError a promise rejects with, or "none" when it rejects with another error or resolves. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await errorOf(promise);
  return isServiceError(error) ? error.code : "none";
};

/** Commits new file contents on top of `baseVersion`. */
const commitWrites = (
  service: Service,
  principal: ReturnType<typeof user>,
  skillId: string,
  baseVersion: number,
  writes: { content: string; path: string }[]
) =>
  service.commit(principal, {
    baseVersion,
    deletes: [],
    message: "Edit",
    skillId,
    writes,
  });

/** "pinned-skill" with approved versions 1, 2 and 3, assigned to a1. */
const threeVersions = async (service: Service): Promise<string> => {
  const { skill } = await createSkill(service, "pinned-skill");
  await commitWrites(service, user(), skill.id, 1, [
    { content: skillMd("pinned-skill", "Second."), path: "SKILL.md" },
  ]);
  await commitWrites(service, user(), skill.id, 2, [
    { content: skillMd("pinned-skill", "Third."), path: "SKILL.md" },
  ]);
  await service.assign(user(), { agentId: A1, skillId: skill.id });
  return skill.id;
};

/** A skill a run of a1 created: its only version is proposed. */
const runDraft = async (service: Service, name: string): Promise<string> => {
  const { skill } = await service.create(run(A1, R1), {
    files: [{ content: skillMd(name), path: "SKILL.md" }],
    message: "Draft",
    name,
  });
  return skill.id;
};

const eventsOf = (db: Setup["db"], type: string) =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, type))
    .all()
    .map((row) => ({
      actorId: row.actorId,
      actorKind: row.actorKind,
      agentId: row.agentId,
      payload: JSON.parse(row.payload ?? "null") as unknown,
      runId: row.runId,
    }));

describe("assign without a pin", () => {
  test("assign hands the agent the latest approved version with its file list", async () => {
    const { service } = setup();
    const { skill } = await service.create(user(), {
      files: [
        { content: skillMd("brief"), path: "SKILL.md" },
        { content: "notes", path: "notes/usage.txt" },
        {
          content: "#!/bin/sh\necho hi\n",
          executable: true,
          path: "bin/tool.sh",
        },
      ],
      message: "First version",
      name: "brief",
    });
    const assigned = await service.assign(user(), {
      agentId: A1,
      skillId: skill.id,
    });
    expect(assigned).toEqual({
      agentId: A1,
      pinnedVersion: null,
      skillId: skill.id,
    });
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [
          fileRecord("SKILL.md", skillMd("brief")),
          fileRecord("bin/tool.sh", "#!/bin/sh\necho hi\n", true),
          fileRecord("notes/usage.txt", "notes"),
        ],
        name: "brief",
        pinned: false,
        skillId: skill.id,
        version: 1,
      },
    ]);
  });

  test("a new approved commit moves the agent to the new version and leaves the assignment alone", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await commitWrites(service, user(), skill.id, 1, [
      { content: skillMd("brief", "Second."), path: "SKILL.md" },
    ]);
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [fileRecord("SKILL.md", skillMd("brief", "Second."))],
        name: "brief",
        pinned: false,
        skillId: skill.id,
        version: 2,
      },
    ]);
    expect(
      await service.assign(user(), { agentId: A1, skillId: skill.id })
    ).toEqual({
      agentId: A1,
      pinnedVersion: null,
      skillId: skill.id,
    });
  });

  test("withContents gives each file its bytes and leaves content out otherwise", async () => {
    const { service } = setup();
    const { skill } = await service.create(user(), {
      files: [
        { content: skillMd("brief"), path: "SKILL.md" },
        { content: "notes", path: "notes/usage.txt" },
      ],
      message: "First version",
      name: "brief",
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    const [withBytes] = await service.forAgent(user(), A1, {
      withContents: true,
    });
    expect(withBytes?.files).toEqual([
      {
        ...fileRecord("SKILL.md", skillMd("brief")),
        content: bytes(skillMd("brief")),
      },
      { ...fileRecord("notes/usage.txt", "notes"), content: bytes("notes") },
    ]);
    const plain = await service.forAgent(user(), A1);
    expect(
      plain.map((entry) => entry.files.map((file) => "content" in file))
    ).toEqual([[false, false]]);
  });
});

describe("pins", () => {
  test("a pin to version 1 keeps the agent on version 1 while later versions are approved", async () => {
    const { service } = setup();
    const skillId = await threeVersions(service);
    expect(
      await service.pin(user(), { agentId: A1, skillId, version: 1 })
    ).toEqual({ agentId: A1, pinnedVersion: 1, skillId });
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [fileRecord("SKILL.md", skillMd("pinned-skill"))],
        name: "pinned-skill",
        pinned: true,
        skillId,
        version: 1,
      },
    ]);
  });

  test("a pin of null follows the latest approved version again", async () => {
    const { service } = setup();
    const skillId = await threeVersions(service);
    await service.pin(user(), { agentId: A1, skillId, version: 1 });
    expect(
      await service.pin(user(), { agentId: A1, skillId, version: null })
    ).toEqual({ agentId: A1, pinnedVersion: null, skillId });
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [fileRecord("SKILL.md", skillMd("pinned-skill", "Third."))],
        name: "pinned-skill",
        pinned: false,
        skillId,
        version: 3,
      },
    ]);
  });

  test("assign on an assigned skill returns the existing pin, changes nothing and writes no second event", async () => {
    const { db, service } = setup();
    const skillId = await threeVersions(service);
    await service.pin(user(), { agentId: A1, skillId, version: 1 });
    expect(await service.assign(user(), { agentId: A1, skillId })).toEqual({
      agentId: A1,
      pinnedVersion: 1,
      skillId,
    });
    const [resolved] = await service.forAgent(user(), A1);
    expect(resolved?.version).toBe(1);
    expect(eventsOf(db, "skill.assigned")).toHaveLength(1);
  });

  test("pinning an agent that does not carry the skill is not_found", async () => {
    const { service } = setup();
    const skillId = await threeVersions(service);
    expect(
      await codeOf(service.pin(user(), { agentId: A2, skillId, version: 1 }))
    ).toBe("not_found");
  });

  test("pinning a version that does not exist is not_found", async () => {
    const { service } = setup();
    const skillId = await threeVersions(service);
    expect(
      await codeOf(service.pin(user(), { agentId: A1, skillId, version: 9 }))
    ).toBe("not_found");
  });

  test("pinning a proposed version is invalid", async () => {
    const { service } = setup();
    const skillId = await runDraft(service, "draft-pin");
    await service.assign(user(), { agentId: A1, skillId });
    expect(
      await codeOf(service.pin(user(), { agentId: A1, skillId, version: 1 }))
    ).toBe("invalid");
  });

  test("pinning a rejected version is invalid", async () => {
    const { service } = setup();
    const skillId = await runDraft(service, "rejected-pin");
    await service.reject(user(), { skillId, version: 1 });
    await service.assign(user(), { agentId: A1, skillId });
    expect(
      await codeOf(service.pin(user(), { agentId: A1, skillId, version: 1 }))
    ).toBe("invalid");
  });
});

describe("forAgent resolves approved versions only", () => {
  test("a skill whose only version is proposed is left out until it is approved", async () => {
    const { service } = setup();
    const skillId = await runDraft(service, "draft-skill");
    await service.assign(user(), { agentId: A1, skillId });
    expect(await service.forAgent(user(), A1)).toEqual([]);
    await service.approve(user(), { skillId, version: 1 });
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [fileRecord("SKILL.md", skillMd("draft-skill"))],
        name: "draft-skill",
        pinned: false,
        skillId,
        version: 1,
      },
    ]);
  });

  test("a newer proposed version is ignored while the older approved one is served", async () => {
    const { service } = setup();
    const skillId = await runDraft(service, "tuned");
    await service.approve(user(), { skillId, version: 1 });
    await service.assign(user(), { agentId: A1, skillId });
    await commitWrites(service, run(A1, R1), skillId, 1, [
      { content: skillMd("tuned", "Proposed."), path: "SKILL.md" },
    ]);
    expect(await service.forAgent(user(), A1)).toEqual([
      {
        files: [fileRecord("SKILL.md", skillMd("tuned"))],
        name: "tuned",
        pinned: false,
        skillId,
        version: 1,
      },
    ]);
  });

  test("skills come back ordered by name, one entry each", async () => {
    const { service } = setup();
    const zeta = await createSkill(service, "zeta");
    const alpha = await createSkill(service, "alpha");
    await service.assign(user(), { agentId: A1, skillId: zeta.skill.id });
    await service.assign(user(), { agentId: A1, skillId: alpha.skill.id });
    const names = (await service.forAgent(user(), A1)).map((skill) => [
      skill.name,
      skill.skillId,
    ]);
    expect(names).toEqual([
      ["alpha", alpha.skill.id],
      ["zeta", zeta.skill.id],
    ]);
  });

  test("a skill assigned to a1 does not appear for a2", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect(await service.forAgent(user(), A2)).toEqual([]);
  });
});

describe("same-name conflicts", () => {
  /** A person's "dup" and a1's own "dup", approved by a person. */
  const twoDups = async (service: Service) => {
    const people = await createSkill(service, "dup");
    const agentOwned = await runDraft(service, "dup");
    await service.approve(user(), { skillId: agentOwned, version: 1 });
    return { agentOwned, people: people.skill.id };
  };

  test("assigning a second skill with the same name as a carried one is a conflict", async () => {
    const { service } = setup();
    const { agentOwned, people } = await twoDups(service);
    await service.assign(user(), { agentId: A1, skillId: people });
    expect(
      await codeOf(service.assign(user(), { agentId: A1, skillId: agentOwned }))
    ).toBe("conflict");
  });

  test("one agent can carry one of two same-named skills while another agent carries the other", async () => {
    const { service } = setup();
    const { agentOwned, people } = await twoDups(service);
    await service.assign(user(), { agentId: A1, skillId: people });
    await service.assign(user(), { agentId: A2, skillId: agentOwned });
    expect((await service.forAgent(user(), A1)).map((s) => s.skillId)).toEqual([
      people,
    ]);
    expect((await service.forAgent(user(), A2)).map((s) => s.skillId)).toEqual([
      agentOwned,
    ]);
  });
});

describe("unassign", () => {
  test("unassign removes the skill, a second unassign is a no-op and assigning again works", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await service.unassign(user(), { agentId: A1, skillId: skill.id });
    expect(await service.forAgent(user(), A1)).toEqual([]);
    expect(
      await errorOf(
        service.unassign(user(), { agentId: A1, skillId: skill.id })
      )
    ).toBeNull();
    expect(
      await service.assign(user(), { agentId: A1, skillId: skill.id })
    ).toEqual({
      agentId: A1,
      pinnedVersion: null,
      skillId: skill.id,
    });
    expect((await service.forAgent(user(), A1)).map((s) => s.skillId)).toEqual([
      skill.id,
    ]);
  });

  test("unassign drops the pin, so assigning again follows the latest approved version", async () => {
    const { service } = setup();
    const skillId = await threeVersions(service);
    await service.pin(user(), { agentId: A1, skillId, version: 1 });
    await service.unassign(user(), { agentId: A1, skillId });
    expect(await service.assign(user(), { agentId: A1, skillId })).toEqual({
      agentId: A1,
      pinnedVersion: null,
      skillId,
    });
    const [resolved] = await service.forAgent(user(), A1);
    expect(resolved?.version).toBe(3);
    expect(resolved?.pinned).toBe(false);
  });
});

describe("assignment validation", () => {
  test("assigning an unknown skill is not_found", async () => {
    const { service } = setup();
    expect(
      await codeOf(service.assign(user(), { agentId: A1, skillId: "missing" }))
    ).toBe("not_found");
  });

  test("assigning to an agent of another workspace is not_found", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    expect(
      await codeOf(service.assign(user(), { agentId: B1, skillId: skill.id }))
    ).toBe("not_found");
  });

  test("a person of another workspace cannot assign a skill of workspace 1", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    expect(
      await codeOf(service.assign(user(W2), { agentId: B1, skillId: skill.id }))
    ).toBe("not_found");
  });

  test("a read-only API key cannot assign", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    expect(
      await errorOf(
        service.assign(readOnlyUser(), { agentId: A1, skillId: skill.id })
      )
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe("forAgent access and show for runs", () => {
  test("a run gets the skills assigned to its own agent", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect(
      (await service.forAgent(run(A1, R1), A1)).map((s) => s.name)
    ).toEqual(["brief"]);
  });

  test("a run asking for another agent's skills is a ForbiddenError", async () => {
    const { service } = setup();
    expect(await errorOf(service.forAgent(run(A1, R1), A2))).toBeInstanceOf(
      ForbiddenError
    );
  });

  test("a person can ask for any agent of the workspace, but an unknown or other-workspace agent is not_found", async () => {
    const { service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect((await service.forAgent(user(), A2)).length).toBe(0);
    expect(await codeOf(service.forAgent(user(), "missing-agent"))).toBe(
      "not_found"
    );
    expect(await codeOf(service.forAgent(user(), B1))).toBe("not_found");
  });

  test("a run can show the approved version of an assigned skill but not an unassigned one", async () => {
    const { service } = setup();
    const assigned = await createSkill(service, "shared");
    const unassigned = await createSkill(service, "private-one");
    await service.assign(user(), { agentId: A1, skillId: assigned.skill.id });
    const shown = await service.show(run(A1, R1), {
      skillId: assigned.skill.id,
      version: 1,
      withContents: false,
    });
    expect(shown.version.number).toBe(1);
    expect(
      await codeOf(
        service.show(run(A1, R1), {
          skillId: unassigned.skill.id,
          version: 1,
          withContents: false,
        })
      )
    ).toBe("not_found");
  });
});

describe("assignment events", () => {
  test("assign, pin and unassign each write one event naming the skill and agent", async () => {
    const { db, service } = setup();
    const { skill } = await createSkill(service, "brief");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await service.pin(user(), { agentId: A1, skillId: skill.id, version: 1 });
    await service.pin(user(), {
      agentId: A1,
      skillId: skill.id,
      version: null,
    });
    await service.unassign(user(), { agentId: A1, skillId: skill.id });
    const base = {
      actorId: "u1",
      actorKind: "user",
      agentId: A1,
      runId: null,
    };
    const named = { agentId: A1, name: "brief", skillId: skill.id };
    expect(eventsOf(db, "skill.assigned")).toEqual([
      { ...base, payload: named },
    ]);
    expect(eventsOf(db, "skill.pinned")).toEqual([
      { ...base, payload: { ...named, version: 1 } },
      { ...base, payload: { ...named, version: null } },
    ]);
    expect(eventsOf(db, "skill.unassigned")).toEqual([
      { ...base, payload: named },
    ]);
  });

  test("file contents appear in no event payload", async () => {
    const { db, service } = setup();
    const secret = "CONTENT-MARKER-4471";
    const { skill } = await createSkill(service, "brief", {
      "notes/usage.txt": secret,
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await service.pin(user(), { agentId: A1, skillId: skill.id, version: 1 });
    await service.unassign(user(), { agentId: A1, skillId: skill.id });
    const payloads = db
      .select()
      .from(eventRows)
      .all()
      .map((row) => row.payload ?? "");
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain(secret);
    }
  });
});
