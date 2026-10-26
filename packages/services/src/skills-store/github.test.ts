import { expect, test } from "bun:test";
import { events } from "@repo/db/schema/events";
import { skillSources, skillVersions } from "@repo/db/schema/skills";
import { eq, sql } from "drizzle-orm";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import type { GithubSkillFetcher } from "./github.ts";
import {
  bytes,
  readOnlyUser,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

const input = {
  path: "skills/shout",
  ref: "main",
  url: "https://github.com/example/repo",
};
const fake = () => {
  const state: {
    failure: string;
    fetched: string[];
    sha: string;
    body: string | null;
    treeFailure: string;
  } = {
    body: null,
    failure: "",
    fetched: [],
    sha: "a".repeat(40),
    treeFailure: "",
  };
  const github: GithubSkillFetcher = {
    resolve() {
      if (state.failure) {
        return Promise.reject(new Error(state.failure));
      }
      return Promise.resolve(state.sha);
    },
    tree({ commitSha }) {
      if (state.treeFailure) {
        return Promise.reject(new Error(state.treeFailure));
      }
      if (state.failure) {
        return Promise.reject(new Error(state.failure));
      }
      state.fetched.push(commitSha);
      return Promise.resolve([
        {
          bytes: bytes(skillMd("shout", state.body ?? commitSha)),
          executable: false,
          path: "SKILL.md",
        },
      ]);
    },
  };
  return { state, ...setup(github) };
};

test("GitHub import pins the resolved SHA, reads its source and re-imports in the same scope", async () => {
  const { service, state, db } = fake();
  const first = await service.importGithub(user(), input);
  expect(first.created).toBe(true);
  expect(first.version.status).toBe("approved");
  expect(db.select().from(skillVersions).get()?.sourceCommitSha).toBe(
    state.sha
  );
  expect(
    (await service.show(user(), { skillId: first.version.skillId, version: 1 }))
      .source?.commitSha
  ).toBe(state.sha);
  await expect(service.importGithub(user(), input)).rejects.toThrow(
    "Nothing changed"
  );
  state.sha = "b".repeat(40);
  const second = await service.importGithub(user(), { ...input, ref: "next" });
  expect(second.created).toBe(false);
  expect(second.version.skillId).toBe(first.version.skillId);
  expect(second.version.number).toBe(2);
  expect(db.select().from(skillSources).all()).toHaveLength(1);
  expect(db.select().from(skillSources).get()).toMatchObject({
    commitSha: state.sha,
    ref: "next",
  });
  expect((await service.list(user()))[0]?.source?.commitSha).toBe(state.sha);
  expect(state.fetched).toEqual([
    "a".repeat(40),
    "a".repeat(40),
    "b".repeat(40),
  ]);
});

test("checks notify once per new commit and importUpdate proposes the exact checked commit until approval moves the pin", async () => {
  const { service, state, db } = fake();
  const first = await service.importGithub(user(), input);
  const { skillId } = first.version;
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 10 });
  state.sha = "b".repeat(40);
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 10 });
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 10 });
  expect(
    db
      .select()
      .from(events)
      .where(eq(events.type, "skill.update_available"))
      .all()
  ).toHaveLength(1);
  state.sha = "c".repeat(40);
  const proposed = await service.importUpdate(user(), skillId);
  expect(proposed.status).toBe("proposed");
  expect(state.fetched.at(-1)).toBe("b".repeat(40));
  expect(
    (await service.proposals(user())).some((v) => v.id === proposed.id)
  ).toBe(true);
  expect(db.select().from(skillSources).get()?.commitSha).toBe("a".repeat(40));
  await service.approve(user(), { skillId, version: proposed.number });
  expect(db.select().from(skillSources).get()?.commitSha).toBe("b".repeat(40));
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 10 });
  expect(
    db
      .select()
      .from(events)
      .where(eq(events.type, "skill.update_available"))
      .all()
  ).toHaveLength(2);
});

test("fetcher failures surface, failed checks stamp checkedAt, and missing setup is clear", async () => {
  const { service, state, db } = fake();
  state.failure = "GitHub rate limit exceeded";
  await expect(service.importGithub(user(), input)).rejects.toThrow(
    state.failure
  );
  expect(db.select().from(skillSources).all()).toHaveLength(0);
  state.failure = "";
  await service.importGithub(user(), input);
  state.failure = "GitHub repository or ref not found";
  const checked = await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 1 });
  expect(checked.failures[0]?.message).toBe(state.failure);
  expect(db.select().from(skillSources).get()?.checkedAt).toBeTruthy();
  await expect(service.importUpdate(user(), "missing")).rejects.toThrow();
  await expect(setup().service.importGithub(user(), input)).rejects.toThrow(
    "GitHub import is not set up"
  );
});

test("update checks require system, batch across workspaces, and writes preserve permissions", async () => {
  const { service, state, db } = fake();
  const first = await service.importGithub(user(), input);
  await service.importGithub(user(W2), input);
  await expect(service.checkUpdates(user(), { limit: 1 })).rejects.toThrow();
  await expect(service.importGithub(readOnlyUser(), input)).rejects.toThrow();
  await expect(
    service.importUpdate(user(W2), first.version.skillId)
  ).rejects.toThrow();
  state.sha = "b".repeat(40);
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 1 });
  expect(
    db
      .select()
      .from(skillSources)
      .all()
      .filter((s) => s.checkedAt)
  ).toHaveLength(1);
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 1 });
  expect(
    db
      .select()
      .from(skillSources)
      .all()
      .filter((s) => s.checkedAt)
  ).toHaveLength(2);
  const agent = await service.importGithub(run(), input);
  expect(agent.version.status).toBe("proposed");
});

test("invalid paths leave the source intact and no update is clear", async () => {
  const { service, state, db } = fake();
  await service.importGithub(user(), input);
  await expect(
    service.importGithub(user(), { ...input, path: "../shout" })
  ).rejects.toThrow();
  expect(db.select().from(skillSources).get()?.commitSha).toBe(state.sha);
  await expect(
    service.importUpdate(
      user(),
      db.select().from(skillSources).get()?.skillId ?? "missing"
    )
  ).rejects.toThrow("No GitHub update available");
});

test("new commits with identical files still produce reviewable proposals and rejection preserves the pin", async () => {
  const { service, state, db } = fake();
  state.body = "unchanged";
  const first = await service.importGithub(user(), input);
  state.sha = "b".repeat(40);
  await service.checkUpdates(SYSTEM_PRINCIPAL, { limit: 1 });
  const proposed = await service.importUpdate(user(), first.version.skillId);
  expect(proposed.status).toBe("proposed");
  await service.reject(user(), {
    skillId: first.version.skillId,
    version: proposed.number,
  });
  expect(db.select().from(skillSources).get()?.commitSha).toBe("a".repeat(40));
  state.treeFailure = "GitHub file not found";
  await expect(
    service.importUpdate(user(), first.version.skillId)
  ).rejects.toThrow(state.treeFailure);
  expect(db.select().from(skillVersions).all()).toHaveLength(2);
});

test("the source and publication roll back together when the source write fails", async () => {
  const { service, db } = fake();
  db.run(
    sql`CREATE TRIGGER refuse_source BEFORE INSERT ON skill_sources BEGIN SELECT RAISE(ABORT, 'source refused'); END`
  );
  await expect(service.importGithub(user(), input)).rejects.toThrow();
  expect(db.select().from(skillVersions).all()).toHaveLength(0);
  expect(db.select().from(skillSources).all()).toHaveLength(0);
  expect(
    db.select().from(events).where(eq(events.type, "skill.imported")).all()
  ).toHaveLength(0);
});
