import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { composeWith, type Infra } from "../compose.ts";
import { createAppHost } from "./app-host-core.ts";
import { fakePorts } from "./fakes.ts";
import type { AppHostProps, AppReplyMessage } from "./types.ts";

const setup = async (fake = true, throws = false, missingExports = false) => {
  const db = migrated(["org_a"]);
  const replies: { host: AppHostProps; message: AppReplyMessage }[] = [];
  const storage = fakePorts();
  const infra: Infra = {
    appReply: missingExports
      ? undefined
      : async (replyHost, message) => {
          if (throws) {
            throw new Error("boom");
          }
          replies.push({ host: replyHost, message });
          await createAppHost(replyHost, storage).setItem(
            "shared",
            "result",
            message.text
          );
        },
    atomic: sqliteAtomic(db),
    blobs: { get: async () => null, put: async () => undefined },
    clock: systemClock,
    cloudRunner: {
      cancel: async () => undefined,
      start: async () => undefined,
    },
    devFakeRuntime: fake,
    fileBlobs: {
      delete: async () => undefined,
      get: async () => null,
      put: async () => undefined,
    },
    publicBaseUrl: "https://example.com",
    relay: noopRelay,
    runTokenKey: Buffer.from(new Uint8Array(32)).toString("base64"),
    secretsKey: Buffer.from(new Uint8Array(32)).toString("base64"),
  };
  const { services } = composeWith({ db, infra });
  const workspace = await services.workspaces.forOrg({ clerkOrgId: "org_a" });
  if (!workspace) {
    throw new Error("missing workspace");
  }
  const user = {
    kind: "user" as const,
    userId: "u1",
    via: "session" as const,
    workspaceId: workspace.id,
  };
  const agent = await services.agents.create(user, {
    model: "m",
    name: "Echo",
    runtime: fake ? "fake" : "cloud",
  });
  const now = new Date().toISOString();
  await db.insert(artifacts).values({
    audience: "workspace",
    createdAt: now,
    createdById: "u1",
    createdByKind: "user",
    currentVersionId: "v1",
    id: "app",
    kind: "app",
    ownerUserId: "u1",
    title: "App",
    updatedAt: now,
    workspaceId: workspace.id,
  });
  await db.insert(artifactVersions).values({
    artifactId: "app",
    authorId: "u1",
    authorKind: "user",
    createdAt: now,
    entry: "index.html",
    fileCount: 1,
    id: "v1",
    manifestKey: "m",
    message: "m",
    number: 1,
    status: "published",
    totalBytes: 1,
    workspaceId: workspace.id,
  });
  await db.insert(triggers).values({
    agentId: agent.id,
    artifactId: "app",
    createdAt: now,
    createdBy: "u1",
    id: "trigger",
    kind: "app",
    name: "App",
    workspaceId: workspace.id,
  });
  const props: AppHostProps = {
    artifactId: "app",
    meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "" },
    versionId: "v1",
    viewer: { endpointId: "ep", kind: "endpoint" },
    workspaceId: workspace.id,
  };
  const host = createAppHost(props, {
    ...storage,
    startRun: services.artifactApp.startRun,
  });
  const grant = () =>
    db.insert(artifactGrants).values({
      createdAt: now,
      id: "g",
      kind: "agent",
      status: "approved",
      target: agent.id,
      versionId: "v1",
      workspaceId: workspace.id,
    });
  return { agent, db, grant, host, replies, services, storage };
};

test("endpoint hand-off requires a live approved grant and enabled trigger", async () => {
  const { db, host, grant, agent } = await setup();
  const input = { agent: agent.id, text: "hello" };
  await expect(host.startRun(input)).rejects.toThrow("not_granted");
  await grant();
  await db.update(triggers).set({ disabledAt: "paused" });
  await expect(host.startRun(input)).rejects.toThrow("forbidden");
  await db.update(triggers).set({ disabledAt: null });
  await db.update(artifacts).set({ currentVersionId: null });
  await expect(host.startRun(input)).rejects.toThrow("not_granted");
});

test("dev fake runtime hands off as nobody and replies into shared storage", async () => {
  const { db, host, grant, agent, replies, storage } = await setup();
  await grant();
  const { runId } = await host.startRun({
    agent: agent.id,
    sessionKey: "channel",
    state: "token",
    text: "hello",
  });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  expect(run?.onBehalfOfUserId).toBeNull();
  expect(JSON.parse(run?.reply ?? "null")).toEqual({
    artifactId: "app",
    kind: "app",
    state: "token",
  });
  expect(await db.select().from(sessions)).toMatchObject([
    { externalKey: "channel", origin: "trigger" },
  ]);
  expect(replies).toMatchObject([
    {
      host: { viewer: { kind: "reply", runId } },
      message: {
        fileIds: [],
        runId,
        state: "token",
        status: "finished",
        text: "Echo: hello",
      },
    },
  ]);
  expect(
    await storage.store.get(
      { area: "shared", artifactId: "app", viewerKey: "" },
      "result"
    )
  ).toBe("Echo: hello");
});

test("a throwing reply records one app.reply_failed event without retry", async () => {
  const { db, host, grant, agent } = await setup(true, true);
  await grant();
  await host.startRun({ agent: agent.id, text: "hello" });
  expect(
    (await db.select().from(events)).filter(
      (e) => e.type === "app.reply_failed"
    )
  ).toHaveLength(1);
});

test("failed runs deliver failed status through the runs event hook", async () => {
  const { host, grant, agent, services, replies } = await setup(false);
  await grant();
  // Finish through the public run service so its event hook delivers the failure.
  const { runId } = await host.startRun({
    agent: agent.id,
    state: "failure-state",
    text: "hello",
  });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "failed",
    status: "failed",
  });
  expect(replies).toMatchObject([
    { message: { state: "failure-state", status: "failed" } },
  ]);
});

test("missing Worker exports records app.reply_failed", async () => {
  const { db, host, grant, agent } = await setup(true, false, true);
  await grant();
  await host.startRun({ agent: agent.id, text: "hello" });
  expect(
    (await db.select().from(events)).filter(
      (e) => e.type === "app.reply_failed"
    )
  ).toHaveLength(1);
});

for (const status of ["cancelled", "interrupted"] as const) {
  test(`${status} runs deliver their terminal status`, async () => {
    const { host, grant, agent, services, replies } = await setup(false);
    await grant();
    const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
    await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
    if (status === "cancelled") {
      await services.runs.cancelRun(SYSTEM_PRINCIPAL, runId);
    } else {
      await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
        status: "aborted",
      });
    }
    expect(replies).toMatchObject([{ message: { status } }]);
  });
}
