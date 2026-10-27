import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactMembers,
  guestIdentities,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createGuestMcpServer } from "@repo/mcp/guest";
import type { LivePort } from "@repo/mcp/ports";
import { connectClient } from "@repo/mcp/testing";
import { authorize } from "@repo/services/authz";
import { createGuestAccessReader } from "@repo/services/live-guests/access";
import { createGuestAsk } from "@repo/services/live-guests/ask";
import { createRestrictedGuestRuntime } from "@repo/services/live-guests/restricted-runtime";
import { createGuestRunAccess } from "@repo/services/live-guests/run-access";
import { createGuestRunStarter } from "@repo/services/live-guests/runs";
import { newGuestSessionToken } from "@repo/services/live-guests/security";
import {
  importRunTokenKey,
  signRunToken,
  verifyRunToken,
} from "@repo/services/run-tokens";
import { createRunsService } from "@repo/services/runs";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";

const setup = async () => {
  const db = migrated();
  const at = new Date("2026-10-28T00:00:00.000Z");
  const clock = { now: () => at, sleep: async () => undefined };
  const expiresAt = "2026-10-29T00:00:00.000Z";
  const artifactId = crypto.randomUUID();
  const token = await newGuestSessionToken();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt: at.toISOString(),
      id: "w",
      name: "Workspace",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values({
      createdAt: at.toISOString(),
      createdBy: "u",
      id: "a",
      instructions: "PRIVATE INSTRUCTIONS",
      model: "captured",
      name: "Agent",
      runtime: "cloud",
      runtimeConfig: "{}",
      slug: "agent",
      status: "active",
      workspaceId: "w",
    })
    .run();
  db.insert(artifacts)
    .values({
      agentId: "a",
      audience: "workspace",
      createdAt: at.toISOString(),
      createdById: "u",
      createdByKind: "user",
      id: artifactId,
      kind: "document",
      ownerUserId: "u",
      title: "Shared",
      updatedAt: at.toISOString(),
      workspaceId: "w",
    })
    .run();
  db.insert(guestIdentities)
    .values({
      createdAt: at.toISOString(),
      displayName: "Guest",
      email: "g@example.com",
      id: "g",
      workspaceId: "w",
    })
    .run();
  db.insert(artifactMembers)
    .values({
      agentRunsPerDay: 1,
      artifactId,
      createdAt: at.toISOString(),
      createdBy: "u",
      expiresAt,
      guestId: "g",
      id: "m",
      principalKind: "guest",
      role: "editor",
      workspaceId: "w",
    })
    .run();
  db.insert(guestSessions)
    .values({
      createdAt: at.toISOString(),
      expiresAt,
      guestId: "g",
      id: "gs",
      lastUsedAt: at.toISOString(),
      tokenHash: token.hash,
      workspaceId: "w",
    })
    .run();
  const atomic = sqliteAtomic(db);
  let off = false;
  const jobs: Promise<void>[] = [];
  const models: unknown[] = [];
  const calls: string[] = [];
  const replies: unknown[] = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const key = await importRunTokenKey(
    btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  );
  let access: ReturnType<typeof createGuestRunAccess>;
  const principal = async (runId: string): Promise<Principal> => {
    const signed = await signRunToken(key, {
      agentId: "a",
      issuedAt: at.getTime(),
      runId,
      workspaceId: "w",
    });
    const checked = await verifyRunToken({ db, key, now: at, token: signed });
    if (!checked.ok) {
      throw new Error("Invalid token");
    }
    return {
      agentId: checked.claims.agentId,
      kind: "run",
      runId,
      scopeArtifactId: checked.scopeArtifactId,
      workspaceId: checked.claims.workspaceId,
    };
  };
  const registry = async (runId: string) => {
    const caller = await principal(runId);
    const scope = { ...(await access(caller, artifactId)), artifactId };
    const refused = (): Promise<never> =>
      Promise.reject(new Error("Unsupported"));
    const live: LivePort = {
      comment: refused,
      comments: refused,
      create: refused,
      edit: refused,
      read: async () => {
        await access(caller, artifactId);
        calls.push("document_read");
        return {
          artifactId,
          blocks: [],
          deletedBlockIds: [],
          present: [],
          revision: 0,
        };
      },
    };
    return createGuestMcpServer({
      authorize: async (id, write) => ({
        ...(await access(caller, id, write)),
        artifactId: id,
      }),
      live,
      scope,
    });
  };
  const adapter = createRestrictedGuestRuntime({
    authorize: async (run) => {
      await service.authorizeScopedRun(SYSTEM_PRINCIPAL, run.id);
    },
    call: async (run, name, input) => {
      const connection = await connectClient(await registry(run.id));
      try {
        const result = await connection.client.callTool({
          arguments: input,
          name,
        });
        if (result.isError) {
          throw new Error("Scoped MCP refused");
        }
        return result;
      } finally {
        await connection.close();
      }
    },
    defer: (work) => {
      jobs.push(work);
    },
    tools: async (run) => {
      const connection = await connectClient(await registry(run.id));
      try {
        return (await connection.client.listTools()).tools.map((tool) => ({
          inputSchema: tool.inputSchema,
          name: tool.name,
        }));
      } finally {
        await connection.close();
      }
    },
    transport: {
      step: async (input) => {
        models.push(input);
        await beforeReply?.();
        return replies.shift();
      },
    },
  });
  const service = createRunsService({
    adapters: [],
    atomic,
    authorizeGuestGrant: async () => undefined,
    blobs: { get: async () => null, put: async () => undefined },
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
    guestAdapter: adapter,
    guestRuntimeReady: (runtime) => runtime === "cloud",
    guestsOff: () => off,
  });
  access = createGuestRunAccess({
    clock,
    db,
    guestsOff: () => off,
    runs: service,
  });
  const reader = createGuestAccessReader({ clock, db, guestsOff: () => off });
  const credential = {
    artifactId,
    sessionToken: token.token,
    workspaceId: "w",
  };
  const ask = createGuestAsk({
    db,
    guests: {
      details: async () => ({
        guestName: "Trusted Guest",
        inviterName: "Owner",
        workspaceName: "Workspace",
      }),
      resolve: reader.resolve,
      startRun: createGuestRunStarter({ access: reader, runs: service }).start,
    },
    presence: async () => ({ present: [], where: undefined }),
    runs: service,
  });
  return {
    access,
    ask,
    beforeReply: (fn: () => Promise<void>) => {
      beforeReply = fn;
    },
    calls,
    credential,
    db,
    jobs,
    models,
    principal,
    replies,
    service,
    setOff: () => {
      off = true;
    },
  };
};

test("guest ask, cap/retry, signed token, scoped MCP and bounded inference use real migrated services", async () => {
  const h = await setup();
  const result = await h.ask(h.credential, {
    requestId: "same",
    text: "Read it",
  });
  const retry = await h.ask(h.credential, {
    requestId: "same",
    text: "Read it",
  });
  expect(retry.runId).toBe(result.runId);
  await expect(
    h.ask(h.credential, { requestId: "next", text: "Again" })
  ).rejects.toThrow();
  h.replies.push(
    {
      input: { artifactId: h.credential.artifactId },
      kind: "tool",
      name: "document_read",
    },
    { kind: "answer", text: "Done" }
  );
  await result.offer();
  await Promise.all(h.jobs);
  expect(h.calls).toEqual(["document_read"]);
  expect(h.models).toHaveLength(2);
  expect(JSON.stringify(h.models)).not.toContain("PRIVATE INSTRUCTIONS");
  const [row] = await h.db
    .select()
    .from(runRows)
    .where(eq(runRows.id, result.runId));
  expect(row?.status).toBe("done");
  expect(row?.onBehalfOfUserId).toBeNull();
  expect(row?.actorKind).toBe("guest");
  expect(row?.inputText).toContain("Trusted Guest");
  expect(row?.scopeArtifactId).toBe(h.credential.artifactId);
});

test.each([
  "bash",
  "mail_send",
  "document_read",
  "document_edit",
  "deck_write",
])(
  "unlisted tool or foreign scope %s never reaches side effects",
  async (name) => {
    const h = await setup();
    const result = await h.ask(h.credential, { requestId: "one", text: "Try" });
    h.replies.push({
      input: { artifactId: crypto.randomUUID() },
      kind: "tool",
      name,
    });
    await result.offer();
    await expect(Promise.all(h.jobs)).rejects.toThrow();
    expect(h.calls).toEqual([]);
  }
);

test("current role/switch/token boundaries block ordinary service authority", async () => {
  const h = await setup();
  const result = await h.ask(h.credential, { requestId: "one", text: "Try" });
  h.replies.push({
    input: { artifactId: h.credential.artifactId },
    kind: "tool",
    name: "document_read",
  });
  await h.service.claimRun(SYSTEM_PRINCIPAL, result.runId);
  const caller = await h.principal(result.runId);
  expect(() =>
    authorize(caller, "library.read", { kind: "library", workspaceId: "w" })
  ).toThrow();
  expect(() =>
    authorize(caller, "mail.send", { kind: "mail", workspaceId: "w" })
  ).toThrow();
  await h.db
    .update(artifactMembers)
    .set({ role: "viewer" })
    .where(eq(artifactMembers.id, "m"));
  await expect(h.access(caller, h.credential.artifactId)).rejects.toThrow();
  await expect(h.principal(result.runId)).rejects.toThrow();
  h.setOff();
  await expect(
    h.service.authorizeScopedRun(SYSTEM_PRINCIPAL, result.runId)
  ).rejects.toThrow();
  expect(h.calls).toEqual([]);
});

test("revocation during model inference fences tool dispatch", async () => {
  const h = await setup();
  const result = await h.ask(h.credential, { requestId: "one", text: "Try" });
  h.replies.push({
    input: { artifactId: h.credential.artifactId },
    kind: "tool",
    name: "document_read",
  });
  h.beforeReply(async () => {
    await h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-28T00:00:00Z" })
      .where(eq(artifactMembers.id, "m"));
  });
  await result.offer();
  await expect(Promise.all(h.jobs)).rejects.toThrow();
  expect(h.calls).toEqual([]);
});
