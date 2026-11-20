import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { artifacts, artifactVersions } from "@repo/db/schema/artifacts";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { type LinkReader, postLinks } from "./post-links.ts";

const NOW = "2026-11-20T09:00:00.000Z";

const user = (userId: string, isAdmin = false): LinkReader => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId: "w1",
});
const u1 = user("u1");
const u2 = user("u2");
const admin = user("adm", true);
const runReader: LinkReader = {
  agentId: "a1",
  kind: "run",
  runId: "r-shared",
  workspaceId: "w1",
};

let db: ReturnType<typeof migrated>;

/** Inserts a session, its agent's run and an artifact version written by that run. */
const seedRun = (
  runId: string,
  sessionId: string,
  options: {
    origin: string;
    isPrivate?: boolean;
    workspaceId?: string;
    agentId?: string;
  }
) => {
  const workspaceId = options.workspaceId ?? "w1";
  const agentId = options.agentId ?? "a1";
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: NOW,
      id: sessionId,
      origin: options.origin,
      private: options.isPrivate === true,
      workspaceId,
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: NOW,
      id: runId,
      inputText: "",
      onBehalfOfUserId: "u1",
      sessionId,
      status: "done",
      workspaceId,
    })
    .run();
};

const seedArtifact = (
  id: string,
  options: {
    runId: string;
    audience: "private" | "workspace";
    title?: string;
    agentId?: string | null;
    deletedAt?: string | null;
    workspaceId?: string;
    versions?: number;
  }
) => {
  const workspaceId = options.workspaceId ?? "w1";
  db.insert(artifacts)
    .values({
      agentId: options.agentId === undefined ? "a1" : options.agentId,
      audience: options.audience,
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      deletedAt: options.deletedAt ?? null,
      id,
      kind: "page",
      ownerUserId: "u1",
      title: options.title ?? id,
      updatedAt: NOW,
      workspaceId,
    })
    .run();
  const versions = options.versions ?? 1;
  for (let number = 1; number <= versions; number += 1) {
    db.insert(artifactVersions)
      .values({
        artifactId: id,
        authorId: "a1",
        authorKind: "agent",
        authorRunId: options.runId,
        createdAt: NOW,
        entry: "index.html",
        fileCount: 1,
        id: `${id}-v${number}`,
        manifestKey: `${workspaceId}/artifact-manifests/${id}-v${number}.json`,
        message: "",
        number,
        status: "published",
        totalBytes: 1,
        workspaceId,
      })
      .run();
  }
};

const seedPost = (
  id: string,
  runId: string | null,
  fileIds: string[],
  authorKind: "user" | "agent" = "agent"
) => {
  db.insert(inboxPosts)
    .values({
      authorId: authorKind === "agent" ? "a1" : "u1",
      authorKind,
      createdAt: NOW,
      fileIds: JSON.stringify(fileIds),
      id,
      runId,
      text: "",
      threadId: "t1",
      workspaceId: "w1",
    })
    .run();
};

beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values([
      {
        clerkOrgId: "org_w1",
        createdAt: NOW,
        id: "w1",
        name: "W1",
        timezone: "UTC",
      },
      {
        clerkOrgId: "org_w2",
        createdAt: NOW,
        id: "w2",
        name: "W2",
        timezone: "UTC",
      },
    ])
    .run();
  db.insert(agents)
    .values([
      {
        createdAt: NOW,
        createdBy: "u1",
        id: "a1",
        instructions: "",
        model: "m",
        name: "A1",
        runtime: "fake",
        runtimeConfig: "{}",
        slug: "a1",
        status: "active",
        workspaceId: "w1",
      },
      {
        createdAt: NOW,
        createdBy: "u1",
        id: "a3",
        instructions: "",
        model: "m",
        name: "A3",
        runtime: "fake",
        runtimeConfig: "{}",
        slug: "a3",
        status: "active",
        workspaceId: "w2",
      },
    ])
    .run();
  db.insert(inboxThreads)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      id: "t1",
      lastPostAt: NOW,
      title: "Thread",
      workspaceId: "w1",
    })
    .run();

  seedRun("r-shared", "s-shared", { origin: "slack" });
  seedRun("r-ui", "s-ui", { origin: "ui" });
  seedRun("r-private", "s-private", { isPrivate: true, origin: "slack" });
  seedRun("r-w2", "s-w2", {
    agentId: "a3",
    origin: "slack",
    workspaceId: "w2",
  });
});

test("a shared post keeps its run, files and artifacts for both users", async () => {
  seedArtifact("pub", {
    audience: "workspace",
    runId: "r-shared",
    title: "Shared report",
  });
  seedPost("p1", "r-shared", ["f1"]);

  const links = await postLinks(db, u2, "t1", [
    { fileIds: ["f1"], id: "p1", runId: "r-shared" },
  ]);
  expect(links.get("p1")).toEqual({
    artifacts: [{ id: "pub", title: "Shared report" }],
    fileIds: ["f1"],
    runId: "r-shared",
  });

  const forU1 = await postLinks(db, u1, "t1", [
    { fileIds: ["f1"], id: "p1", runId: "r-shared" },
  ]);
  expect(forU1.get("p1")?.runId).toBe("r-shared");
  expect(forU1.get("p1")?.fileIds).toEqual(["f1"]);
  expect(forU1.get("p1")?.artifacts.map((a) => a.id)).toEqual(["pub"]);
});

test("a run principal sees the links of a shared run", async () => {
  seedArtifact("pub", { audience: "workspace", runId: "r-shared" });
  seedPost("p1", "r-shared", ["f1"]);

  const links = await postLinks(db, runReader, "t1", [
    { fileIds: ["f1"], id: "p1", runId: "r-shared" },
  ]);
  expect(links.get("p1")?.runId).toBe("r-shared");
  expect(links.get("p1")?.artifacts.map((a) => a.id)).toEqual(["pub"]);
});

test("a run in a ui session shows to its opener only", async () => {
  seedArtifact("ui-art", {
    audience: "workspace",
    runId: "r-ui",
    title: "UI work",
  });
  seedPost("p2", "r-ui", ["f2"]);
  const post = { fileIds: ["f2"], id: "p2", runId: "r-ui" };

  const forU1 = await postLinks(db, u1, "t1", [post]);
  expect(forU1.get("p2")).toEqual({
    artifacts: [{ id: "ui-art", title: "UI work" }],
    fileIds: ["f2"],
    runId: "r-ui",
  });

  const forU2 = await postLinks(db, u2, "t1", [post]);
  expect(forU2.get("p2")).toEqual({ artifacts: [], fileIds: [], runId: null });
});

test("a run in a private session shows to its opener only", async () => {
  seedArtifact("priv-run", { audience: "workspace", runId: "r-private" });
  seedPost("p3", "r-private", ["f3"]);
  const post = { fileIds: ["f3"], id: "p3", runId: "r-private" };

  const forU1 = await postLinks(db, u1, "t1", [post]);
  expect(forU1.get("p3")?.runId).toBe("r-private");
  expect(forU1.get("p3")?.fileIds).toEqual(["f3"]);
  expect(forU1.get("p3")?.artifacts.map((a) => a.id)).toEqual(["priv-run"]);

  const forU2 = await postLinks(db, u2, "t1", [post]);
  expect(forU2.get("p3")).toEqual({ artifacts: [], fileIds: [], runId: null });
});

test("a private artifact lists for its owner and admins, not for another user", async () => {
  seedArtifact("secret", {
    audience: "private",
    runId: "r-shared",
    title: "Secret",
  });
  seedPost("p1", "r-shared", ["f1"]);
  const post = { fileIds: ["f1"], id: "p1", runId: "r-shared" };

  const forU1 = await postLinks(db, u1, "t1", [post]);
  expect(forU1.get("p1")?.artifacts).toEqual([
    { id: "secret", title: "Secret" },
  ]);

  const forAdmin = await postLinks(db, admin, "t1", [post]);
  expect(forAdmin.get("p1")?.artifacts).toEqual([
    { id: "secret", title: "Secret" },
  ]);

  const forU2 = await postLinks(db, u2, "t1", [post]);
  expect(forU2.get("p1")).toEqual({
    artifacts: [],
    fileIds: ["f1"],
    runId: "r-shared",
  });
});

test("a deleted artifact is not listed", async () => {
  seedArtifact("gone", {
    audience: "workspace",
    deletedAt: NOW,
    runId: "r-shared",
  });
  seedPost("p1", "r-shared", []);

  const links = await postLinks(db, u1, "t1", [
    { fileIds: [], id: "p1", runId: "r-shared" },
  ]);
  expect(links.get("p1")?.artifacts).toEqual([]);
});

test("a user post keeps its files and has no run", async () => {
  seedPost("p9", null, ["f9"], "user");

  const links = await postLinks(db, u2, "t1", [
    { fileIds: ["f9"], id: "p9", runId: null },
  ]);
  expect(links.get("p9")).toEqual({
    artifacts: [],
    fileIds: ["f9"],
    runId: null,
  });
});

test("a run in another workspace is stripped", async () => {
  seedArtifact("other", {
    agentId: "a3",
    audience: "workspace",
    runId: "r-w2",
    workspaceId: "w2",
  });
  seedPost("p4", "r-w2", ["f4"]);

  const links = await postLinks(db, u1, "t1", [
    { fileIds: ["f4"], id: "p4", runId: "r-w2" },
  ]);
  expect(links.get("p4")).toEqual({ artifacts: [], fileIds: [], runId: null });
});

test("two versions of one artifact by one run list the artifact once", async () => {
  seedArtifact("pub", {
    audience: "workspace",
    runId: "r-shared",
    title: "Two versions",
    versions: 2,
  });
  seedPost("p1", "r-shared", []);

  const links = await postLinks(db, u1, "t1", [
    { fileIds: [], id: "p1", runId: "r-shared" },
  ]);
  expect(links.get("p1")?.artifacts).toEqual([
    { id: "pub", title: "Two versions" },
  ]);
});
