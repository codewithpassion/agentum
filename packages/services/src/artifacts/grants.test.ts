import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { createRequestsService } from "../requests.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
import { createRunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL as system } from "../workspaces.ts";
import { createArtifactGrantsService, type ToolCatalog } from "./grants.ts";
import { agentCanUpdate } from "./policy.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const ARTIFACT = "0b6f4c2e-8a1d-4f3e-9c2b-7d5e1a2b3c4d";
const PAGE = "5e2d9a14-3c7b-4f80-a6d1-2f9e8b7c6a50";

const owner: Principal = {
  isAdmin: false,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};
const stranger: Principal = { ...owner, userId: "u2" };
const admin: Principal = { ...owner, isAdmin: true, userId: "u3" };

const TOOLS: Record<string, boolean> = {
  "linear/get_issue": true,
  "linear/list_issues": true,
  "linear/save_issue": false,
};
const lookedUpFor: (string | null)[] = [];
const catalog: ToolCatalog = {
  lookup: (_workspaceId, key, forAgentId) => {
    lookedUpFor.push(forAgentId);
    return Promise.resolve(
      key in TOOLS ? { readOnly: TOOLS[key] === true } : null
    );
  },
};

const manifest = (body: object) => [
  { path: "index.html", text: "<p>hi</p>" },
  { path: "server/index.js", text: "export default {}" },
  { path: "agentum.json", text: JSON.stringify(body) },
];

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createArtifactGrantsService>;
let requests: ReturnType<typeof createRequestsService>;
let agentId: string;
let otherAgentId: string;
let runPrincipal: Principal;
let resumed: string[];
let types: string[];

const setup = async () => {
  db = migrated();
  resumed = [];
  types = [];
  let now = Date.parse(NOW);
  await db.insert(workspaces).values({
    clerkOrgId: "org1",
    createdAt: NOW,
    id: "w1",
    name: "Test",
    timezone: "UTC",
  });
  const clock = {
    now: () => new Date(now),
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const events = createEventsService({ blobs, db });
  events.onAppend((event) => {
    types.push(event.type);
    return Promise.resolve();
  });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: (_run, request) => {
      resumed.push(request.id);
      return Promise.resolve();
    },
  };
  const runs = createRunsService({
    adapters: [adapter],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  const agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(owner, {
      model: "m",
      name: "Builder",
      runtime: "cloud",
    })
  ).id;
  otherAgentId = (
    await agents.create(owner, { model: "m", name: "Other", runtime: "cloud" })
  ).id;
  requests = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(createMasker({})) },
  });
  service = createArtifactGrantsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    requests,
    tools: catalog,
  });
  const run = await runs.startRun(owner, {
    agentId,
    input: { text: "go" },
    // Every member sees a slack session, so a member who is not the owner can answer its cards.
    session: { origin: "slack" },
  });
  await runs.claimRun(system, run.runId);
  runPrincipal = {
    agentId,
    kind: "run",
    runId: run.runId,
    workspaceId: "w1",
  };
  await db.insert(artifacts).values([
    {
      agentId,
      audience: "workspace",
      createdAt: NOW,
      createdById: agentId,
      createdByKind: "agent",
      currentVersionId: "v1",
      id: ARTIFACT,
      kind: "app",
      ownerUserId: "u1",
      title: "Client intake",
      updatedAt: NOW,
      workspaceId: "w1",
    },
    {
      audience: "workspace",
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      id: PAGE,
      kind: "page",
      ownerUserId: "u1",
      title: "A page",
      updatedAt: NOW,
      workspaceId: "w1",
    },
  ]);
};

const addVersion = async (
  id: string,
  number: number,
  overrides: Partial<typeof artifactVersions.$inferInsert> = {}
) => {
  await db.insert(artifactVersions).values({
    artifactId: ARTIFACT,
    authorId: agentId,
    authorKind: "agent",
    createdAt: NOW,
    entry: "index.html",
    fileCount: 1,
    id,
    manifestKey: `w1/artifact-manifests/${id}.json`,
    message: "m",
    number,
    status: "proposed",
    totalBytes: 1,
    workspaceId: "w1",
    ...overrides,
  });
};

const record = (
  versionId: string,
  body: object,
  principal: Principal = runPrincipal
) =>
  service.recordVersionGrants(principal, {
    artifactId: ARTIFACT,
    files: manifest(body),
    versionId,
  });

const versionStatus = async (id: string) =>
  (
    await db
      .select({ status: artifactVersions.status })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, id))
  )[0]?.status;
const currentVersion = async () =>
  (
    await db
      .select({ id: artifacts.currentVersionId })
      .from(artifacts)
      .where(eq(artifacts.id, ARTIFACT))
  )[0]?.id;
const eventTypes = async () =>
  (await db.select({ type: eventRows.type }).from(eventRows)).map(
    (row) => row.type
  );

beforeEach(async () => {
  await setup();
  // Version 1 is live and its grants are approved, as an earlier promote left them.
  await addVersion("v1", 1, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  await record(
    "v1",
    { hosts: ["api.example.com"], tools: [{ tool: "linear/get_issue" }] },
    owner
  );
});

test("a person's own version is approved as written", async () => {
  await addVersion("v2", 2, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  const grants = await record(
    "v2",
    { tools: [{ tool: "linear/list_issues" }] },
    owner
  );
  expect(grants.map((grant) => [grant.target, grant.status])).toEqual([
    ["linear/list_issues", "approved"],
  ]);
});

test("an agent recording a person's version gets no approval from the person", async () => {
  await addVersion("v2", 2, { authorId: "u1", authorKind: "user" });
  const grants = await record("v2", { hosts: ["files.example.com"] });
  expect(grants.map((grant) => grant.status)).toEqual(["pending"]);
});

test("an agent's version keeps approved grants the current version holds and waits on the rest", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", {
    hosts: ["api.example.com", "files.example.com"],
    tools: [{ tool: "linear/get_issue" }],
  });
  expect(grants.map((grant) => [grant.target, grant.status])).toEqual(
    [
      ["files.example.com", "pending"],
      ["api.example.com", "approved"],
      ["linear/get_issue", "approved"],
    ].sort()
  );
});

test("recording twice for one version returns the same rows", async () => {
  await addVersion("v2", 2);
  const first = await record("v2", { tools: [{ tool: "linear/list_issues" }] });
  const second = await record("v2", { tools: [{ tool: "linear/get_issue" }] });
  expect(second.map((grant) => grant.id)).toEqual(
    first.map((grant) => grant.id)
  );
});

test("a tool that is not read-only cannot be granted", async () => {
  await addVersion("v2", 2);
  await expect(
    record("v2", { tools: [{ tool: "linear/save_issue" }] })
  ).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("not read-only"),
  });
});

test("an unknown tool and a bad manifest are refused", async () => {
  await addVersion("v2", 2);
  await expect(
    record("v2", { tools: [{ tool: "nope/missing" }] })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(record("v2", { hosts: ["HTTP://x"] })).rejects.toMatchObject({
    code: "invalid",
  });
});

test("a limits change is a new grant that needs approval", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", {
    tools: [{ limits: { limit: { max: 50 } }, tool: "linear/get_issue" }],
  });
  const limited = grants.find((grant) => grant.target.includes("#"));
  expect(limited?.status).toBe("pending");
  expect(
    grants.find((grant) => grant.target === "linear/get_issue")?.status
  ).toBe("approved");
});

test("R2.4: a version that adds nothing beyond the approved set goes live at once", async () => {
  await addVersion("v2", 2);
  await record("v2", { tools: [{ tool: "linear/get_issue" }] });
  const result = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(result).toEqual({ status: "promoted", version: 2 });
  expect(await versionStatus("v2")).toBe("published");
  expect(await currentVersion()).toBe("v2");
  expect(await eventTypes()).toContain("artifact.promoted");
  expect(await db.select().from(runRequests)).toHaveLength(0);
});

test("R2.4: a version that adds a grant waits in Needs you, then promotes after approval", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", {
    tools: [{ tool: "linear/list_issues" }],
  });
  const pending = grants.find((grant) => grant.status === "pending");
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(waiting.status).toBe("waiting");
  expect(await versionStatus("v2")).toBe("proposed");
  expect(await currentVersion()).toBe("v1");
  const [request] = await db.select().from(runRequests);
  expect(request?.status).toBe("pending");
  expect(request?.kind).toBe("approval");
  expect(types).toContain("request.opened");
  // Asking again does not open a second card.
  const again = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(again).toMatchObject({ requestId: request?.id, status: "waiting" });
  expect(await db.select().from(runRequests)).toHaveLength(1);
  // A person decides the grant, which settles the card.
  await service.decideGrant(owner, {
    decision: "approved",
    grantId: pending?.id ?? "",
  });
  const [closed] = await db.select().from(runRequests);
  expect(closed?.status).toBe("answered");
  // The tool returned `waiting`, so no runtime holds the card.
  expect(resumed).toEqual([]);
  expect(types).toContain("request.answered");
  expect(await eventTypes()).toContain("artifact.grant_decided");
  const done = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(done).toEqual({ status: "promoted", version: 2 });
  expect(await currentVersion()).toBe("v2");
});

test("a person promoting a version with pending grants gets a conflict and no card", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  await expect(
    service.promote(owner, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await db.select().from(runRequests)).toHaveLength(0);
});

test("rejecting a grant rejects the version and denies the card", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", { hosts: ["files.example.com"] });
  await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  await service.decideGrant(owner, {
    decision: "rejected",
    grantId: grants[0]?.id as string,
  });
  expect(await versionStatus("v2")).toBe("rejected");
  const [request] = await db.select().from(runRequests);
  expect(JSON.parse(request?.answer ?? "{}")).toEqual({ decision: "deny" });
  await expect(
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await currentVersion()).toBe("v1");
});

test("only the owner or an admin decides a grant, and only once", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", { hosts: ["files.example.com"] });
  const grantId = grants[0]?.id as string;
  await expect(
    service.decideGrant(stranger, { decision: "approved", grantId })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.decideGrant(runPrincipal, { decision: "approved", grantId })
  ).rejects.toMatchObject({ code: "forbidden" });
  await service.decideGrant(admin, { decision: "approved", grantId });
  await expect(
    service.decideGrant(owner, { decision: "rejected", grantId })
  ).rejects.toMatchObject({ code: "conflict" });
  const [row] = await service.list(owner, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(row).toMatchObject({ decidedBy: "u3", status: "approved" });
});

test("promote refuses non-app artifacts, another agent's artifact and an unknown version", async () => {
  await expect(
    service.promote(owner, { artifactId: PAGE, versionId: "x" })
  ).rejects.toMatchObject({ code: "invalid" });
  const foreign: Principal = {
    ...runPrincipal,
    agentId: otherAgentId,
  } as Principal;
  await addVersion("v2", 2);
  await expect(
    service.promote(foreign, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.promote(owner, { artifactId: ARTIFACT, versionId: "nope" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("promoting the current version again changes nothing", async () => {
  expect(
    await service.promote(owner, { artifactId: ARTIFACT, versionId: "v1" })
  ).toEqual({ status: "promoted", version: 1 });
});

test("R2.9: the owner hands the artifact to an agent, who may then update it", async () => {
  const row = async () =>
    (await db.select().from(artifacts).where(eq(artifacts.id, ARTIFACT)))[0];
  await service.handTo(owner, { agentId: otherAgentId, artifactId: ARTIFACT });
  const handed = await row();
  expect(handed?.handedToAgentId).toBe(otherAgentId);
  expect(
    agentCanUpdate(
      {
        agentId: handed?.agentId ?? null,
        audience: "workspace",
        handedToAgentId: handed?.handedToAgentId ?? null,
        ownerUserId: "u1",
      },
      otherAgentId
    )
  ).toBe(true);
  expect(await eventTypes()).toContain("artifact.handed_to");
  await service.handTo(admin, { agentId: null, artifactId: ARTIFACT });
  expect((await row())?.handedToAgentId).toBeNull();
});

test("hand-to refuses a stranger, an agent, and an unknown agent", async () => {
  await expect(
    service.handTo(stranger, { agentId: otherAgentId, artifactId: ARTIFACT })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.handTo(runPrincipal, {
      agentId: otherAgentId,
      artifactId: ARTIFACT,
    })
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    service.handTo(owner, { agentId: "missing", artifactId: ARTIFACT })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("handing to the same agent twice writes one event", async () => {
  await service.handTo(owner, { agentId: otherAgentId, artifactId: ARTIFACT });
  await service.handTo(owner, { agentId: otherAgentId, artifactId: ARTIFACT });
  expect(
    (await eventTypes()).filter((type) => type === "artifact.handed_to")
  ).toHaveLength(1);
});

test("dropping an approved argument limit needs a person again", async () => {
  await addVersion("v2", 2, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  await record(
    "v2",
    { tools: [{ limits: { limit: { max: 10 } }, tool: "linear/list_issues" }] },
    owner
  );
  await db
    .update(artifacts)
    .set({ currentVersionId: "v2" })
    .where(eq(artifacts.id, ARTIFACT));
  await addVersion("v3", 3);
  const grants = await record("v3", {
    tools: [{ tool: "linear/list_issues" }],
  });
  expect(grants.map((grant) => grant.status)).toEqual(["pending"]);
  const same = await addVersion("v4", 4).then(() =>
    record("v4", {
      tools: [{ limits: { limit: { max: 10 } }, tool: "linear/list_issues" }],
    })
  );
  expect(same.map((grant) => grant.status)).toEqual(["approved", "approved"]);
});

test("a waiting promote leaves the run running", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  const [run] = await db.select().from(runRows);
  expect(run?.status).toBe("running");
});

test("allowing the card decides its grants and takes the version live", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  await requests.answer(owner, {
    answer: { decision: "allow_once" },
    requestId: waiting.requestId,
    via: "web",
  });
  // No promote call needed: the answer carries the version forward.
  expect(await versionStatus("v2")).toBe("published");
  expect(await currentVersion()).toBe("v2");
  expect(await eventTypes()).toContain("artifact.promoted");
  const [grant] = await service.list(owner, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(grant).toMatchObject({ decidedBy: "u1", status: "approved" });
  expect(
    await service.promote(runPrincipal, {
      artifactId: ARTIFACT,
      versionId: "v2",
    })
  ).toEqual({ status: "promoted", version: 2 });
  expect(await db.select().from(runRequests)).toHaveLength(1);
});

test("denying the card rejects the version", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  await requests.answer(owner, {
    answer: { decision: "deny" },
    requestId: waiting.requestId,
    via: "web",
  });
  expect(await versionStatus("v2")).toBe("rejected");
  await expect(
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "conflict" });
});

test("a card answered by someone who cannot decide is a conflict, not a new card", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  // Answered by someone else, written straight in: no answer event fires.
  await db
    .update(runRequests)
    .set({
      answer: JSON.stringify({ decision: "allow_once" }),
      answeredBy: "u9",
      status: "answered",
    })
    .where(eq(runRequests.id, waiting.requestId));
  await expect(
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await db.select().from(runRequests)).toHaveLength(1);
  expect(await versionStatus("v2")).toBe("proposed");
});

test("answering a stale card decides the grants but does not roll the app back", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  await addVersion("v3", 3);
  await record("v3", { tools: [{ tool: "linear/get_issue" }] });
  await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v3",
  });
  await requests.answer(owner, {
    answer: { decision: "allow_once" },
    requestId: waiting.requestId,
    via: "web",
  });
  expect(await currentVersion()).toBe("v3");
  const [grant] = await service.list(owner, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(grant?.status).toBe("approved");
});

const count = async (type: string) =>
  (await eventTypes()).filter((found) => found === type).length;

test("deciding the last grant of a requested promote takes the version live, once", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", { hosts: ["files.example.com"] });
  await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  await service.decideGrant(owner, {
    decision: "approved",
    grantId: grants[0]?.id as string,
  });
  expect(await versionStatus("v2")).toBe("published");
  expect(await currentVersion()).toBe("v2");
  expect(await count("artifact.promoted")).toBe(1);
  expect(await count("artifact.grant_decided")).toBe(1);
  const [card] = await db.select().from(runRequests);
  expect(card?.status).toBe("answered");
  // The card's answer event and a repeated promote add nothing.
  expect(
    await service.promote(runPrincipal, {
      artifactId: ARTIFACT,
      versionId: "v2",
    })
  ).toEqual({ status: "promoted", version: 2 });
  expect(await count("artifact.promoted")).toBe(1);
  expect(await count("artifact.grant_decided")).toBe(1);
});

test("deciding grants when no promote was asked leaves the version proposed", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", { hosts: ["files.example.com"] });
  await service.decideGrant(owner, {
    decision: "approved",
    grantId: grants[0]?.id as string,
  });
  expect(await versionStatus("v2")).toBe("proposed");
  expect(await count("artifact.promoted")).toBe(0);
});

test("two decisions on one grant write one event", async () => {
  await addVersion("v2", 2);
  const grants = await record("v2", { hosts: ["files.example.com"] });
  const grantId = grants[0]?.id as string;
  const results = await Promise.allSettled([
    service.decideGrant(owner, { decision: "approved", grantId }),
    service.decideGrant(owner, { decision: "approved", grantId }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  expect(await count("artifact.grant_decided")).toBe(1);
});

test("a member who is not the owner answering the card decides nothing", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  await requests.answer(stranger, {
    answer: { decision: "allow_once" },
    requestId: waiting.requestId,
    via: "web",
  });
  expect(await versionStatus("v2")).toBe("proposed");
  expect(await count("artifact.grant_decided")).toBe(0);
  await expect(
    service.promote(runPrincipal, {
      artifactId: ARTIFACT,
      versionId: "v2",
    })
  ).rejects.toMatchObject({ code: "conflict" });
  // The owner still decides on the artifact page, and the version goes live.
  const [grant] = await service.list(owner, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  await service.decideGrant(owner, {
    decision: "approved",
    grantId: grant?.id as string,
  });
  expect(await currentVersion()).toBe("v2");
  expect(await db.select().from(runRequests)).toHaveLength(1);
});

test("a card for another kind of request is left alone", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  await requests.open(system, {
    input: { command: "ls" },
    kind: "approval",
    runId: (runPrincipal as { runId: string }).runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "call1",
  });
  const [card] = await db.select().from(runRequests);
  await requests.answer(owner, {
    answer: { decision: "allow_once" },
    requestId: card?.id as string,
    via: "web",
  });
  expect(await versionStatus("v2")).toBe("proposed");
  expect(await count("artifact.grant_decided")).toBe(0);
});

test("two promotes at once announce one promotion", async () => {
  await addVersion("v2", 2);
  await record("v2", { tools: [{ tool: "linear/get_issue" }] });
  const results = await Promise.all([
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" }),
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" }),
  ]);
  expect(results).toEqual([
    { status: "promoted", version: 2 },
    { status: "promoted", version: 2 },
  ]);
  expect(await currentVersion()).toBe("v2");
  expect(await count("artifact.promoted")).toBe(1);
});

test("a go-live that stopped after publishing is finished by the next promote", async () => {
  await addVersion("v2", 2, { status: "published" });
  expect(await currentVersion()).toBe("v1");
  expect(
    await service.promote(owner, { artifactId: ARTIFACT, versionId: "v2" })
  ).toEqual({ status: "promoted", version: 2 });
  expect(await currentVersion()).toBe("v2");
});

test("promoting a version older than the live one is refused, also after a stale card", async () => {
  await addVersion("v2", 2);
  await record("v2", { hosts: ["files.example.com"] });
  const waiting = await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  if (waiting.status !== "waiting") {
    throw new Error("expected waiting");
  }
  await addVersion("v3", 3);
  await record("v3", { tools: [{ tool: "linear/get_issue" }] });
  await service.promote(runPrincipal, {
    artifactId: ARTIFACT,
    versionId: "v3",
  });
  await requests.answer(owner, {
    answer: { decision: "allow_once" },
    requestId: waiting.requestId,
    via: "web",
  });
  await expect(
    service.promote(runPrincipal, { artifactId: ARTIFACT, versionId: "v2" })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await currentVersion()).toBe("v3");
});

test("checkManifest names tools by the artifact's maker when one is given, not the calling agent", async () => {
  await setup();
  lookedUpFor.length = 0;
  const handedRun: Principal = {
    agentId: otherAgentId,
    kind: "run",
    runId: "r-handed",
    workspaceId: "w1",
  };
  const files = manifest({ tools: [{ tool: "linear/get_issue" }] });
  await service.checkManifest(handedRun, files);
  expect(lookedUpFor).toEqual([otherAgentId]);
  lookedUpFor.length = 0;
  await service.checkManifest(handedRun, files, agentId);
  expect(lookedUpFor).toEqual([agentId]);
});

test("publishing declarations persists pending endpoint and agent grant rows", async () => {
  await addVersion("v2", 2);
  await record("v2", {
    agents: [{ agent: otherAgentId }],
    endpoints: [{ name: "discord" }],
  });
  const rows = await db
    .select()
    .from(artifactGrants)
    .where(eq(artifactGrants.versionId, "v2"));
  expect(
    rows
      .map(({ kind, target, status }) => ({ kind, status, target }))
      .sort((a, b) => a.kind.localeCompare(b.kind))
  ).toEqual([
    { kind: "agent", status: "pending", target: otherAgentId },
    { kind: "endpoint", status: "pending", target: "discord" },
  ]);
});

test("agent approval creates a tokenless trigger and reuses revoked and paused rows", async () => {
  await addVersion("v2", 2);
  const [grant] = await record("v2", { agents: [{ agent: otherAgentId }] });
  if (!grant) {
    throw new Error("missing grant");
  }
  await service.decideGrant(owner, { decision: "approved", grantId: grant.id });
  const [first] = await db.select().from(triggers);
  expect(first).toMatchObject({
    agentId: otherAgentId,
    artifactId: ARTIFACT,
    disabledAt: null,
    kind: "app",
    proposedByAgentId: null,
    tokenHash: null,
  });
  if (!first) {
    throw new Error("missing trigger");
  }
  await db
    .update(triggers)
    .set({ disabledAt: NOW, revokedAt: NOW })
    .where(eq(triggers.id, first.id));
  await addVersion("v3", 3);
  const [next] = await record("v3", { agents: [{ agent: otherAgentId }] });
  if (!next) {
    throw new Error("missing grant");
  }
  await service.decideGrant(owner, { decision: "approved", grantId: next.id });
  expect(await db.select().from(triggers)).toMatchObject([
    { disabledAt: NOW, id: first.id, revokedAt: null },
  ]);
});

test("a person's live version dropping an agent pauses its trigger", async () => {
  await addVersion("v2", 2, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  await db
    .update(artifacts)
    .set({ currentVersionId: "v2" })
    .where(eq(artifacts.id, ARTIFACT));
  await record("v2", { agents: [{ agent: otherAgentId }] }, owner);
  expect((await db.select().from(triggers))[0]?.disabledAt).toBeNull();
  await addVersion("v3", 3, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  await db
    .update(artifacts)
    .set({ currentVersionId: "v3" })
    .where(eq(artifacts.id, ARTIFACT));
  await record("v3", {}, owner);
  expect((await db.select().from(triggers))[0]?.disabledAt).toBe(NOW);
});

test("an agent outside the artifact workspace cannot get an app trigger", async () => {
  await addVersion("v2", 2);
  await db.insert(workspaces).values({
    clerkOrgId: "org2",
    createdAt: NOW,
    id: "w2",
    name: "Other",
    timezone: "UTC",
  });
  const events = createEventsService({
    blobs: { get: async () => null, put: async () => undefined },
    db,
  });
  const foreign = await createAgentsService({ db, events }).create(
    { ...owner, workspaceId: "w2" },
    { model: "m", name: "Foreign", runtime: "cloud" }
  );
  await expect(
    record("v2", { agents: [{ agent: foreign.id }] })
  ).rejects.toThrow("artifact workspace");
  expect(await db.select().from(triggers)).toEqual([]);
});

test("a person can revoke an approved agent grant and its trigger stays paused", async () => {
  await addVersion("v2", 2, {
    authorId: "u1",
    authorKind: "user",
    status: "published",
  });
  await db
    .update(artifacts)
    .set({ currentVersionId: "v2" })
    .where(eq(artifacts.id, ARTIFACT));
  const [grant] = await record(
    "v2",
    { agents: [{ agent: otherAgentId }] },
    owner
  );
  if (!grant) {
    throw new Error("missing grant");
  }
  await service.decideGrant(owner, { decision: "rejected", grantId: grant.id });
  expect((await db.select().from(triggers))[0]?.disabledAt).toBe(NOW);
  expect(await versionStatus("v2")).toBe("published");
  expect(
    (await service.list(owner, { artifactId: ARTIFACT, versionId: "v2" }))[0]
      ?.status
  ).toBe("rejected");
});
