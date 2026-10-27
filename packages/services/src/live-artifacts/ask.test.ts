import { describe, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import {
  artifactAskDispatches,
  artifactComments,
  artifactCommentThreads,
  artifactMembers,
} from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { eq } from "drizzle-orm";
import { bytes, harness, principals } from "../artifacts/test-harness.ts";
import { createRunsService } from "../runs.ts";
import { createSessionsService } from "../sessions.ts";
import type { Principal } from "../workspaces.ts";
import { createLiveAskService } from "./ask.ts";
import { createLiveArtifactsWithAsk } from "./factory.ts";

const setup = () => {
  const h = harness();
  h.db.update(agents).set({ runtime: "machine" }).run();
  const clock = {
    now: () => new Date("2026-10-27T00:00:00Z"),
    sleep: async () => undefined,
  };
  const offered: string[] = [];
  const eventBlobs = new Map<string, string>();
  const runService = createRunsService({
    ...h,
    adapters: [
      {
        cancel: async () => undefined,
        dispatch: async (_db, run) => {
          await Promise.resolve();
          offered.push(run.id);
        },
        kind: "machine",
      },
    ],
    blobs: {
      get: async (key) => eventBlobs.get(key) ?? null,
      put: async (key, value) => {
        await Promise.resolve();
        eventBlobs.set(key, value);
      },
    },
    clock,
    devFakeRuntime: false,
    gateways: [],
  });
  let fail = false;
  let ambiguous = false;
  let failAck = false;
  let memberActive = true;
  const deps = {
    ...h,
    anchors: {
      guardAgentSnapshot: async () => undefined,
      resolve: async (
        _scope: unknown,
        anchor: import("@repo/protocol/live").CommentAnchor
      ) => ({ anchor, quote: "words" }),
    },
    artifacts: h.service,
    atomic: async (statements: Parameters<typeof h.atomic>[0]) => {
      if (failAck) {
        throw new Error("ack unavailable");
      }
      return await h.atomic(statements);
    },
    changes: { revert: async () => ({ revision: 10 }) },
    clock,
    content: {
      exportDocument: async () => ({ html: "<p>body</p>", markdown: "body" }),
      importMarkdown: async (text: string) => ({
        revision: 0,
        state: bytes(text || "empty"),
      }),
      loadDocument: async (state: Uint8Array) => ({ revision: 0, state }),
    },
    identity: async (member: Extract<Principal, { kind: "user" | "run" }>) => ({
      color: "#123abc",
      name: member.kind === "user" ? `Name ${member.userId}` : "Agent",
    }),
    presence: async (
      _scope: unknown,
      member: Extract<Principal, { kind: "user" }>
    ) => ({
      present: [
        {
          id: member.userId,
          kind: "member" as const,
          name: `Name ${member.userId}`,
          role: "editor",
        },
        { id: "a1", kind: "agent" as const, name: "Agent", role: "agent" },
      ],
      where: {
        blockId: `block-${member.userId}`,
        selection: `selection-${member.userId}`,
      },
    }),
    resolveMember: async (_scope: unknown, userId: string) =>
      memberActive ? { ...principals.owner, userId } : null,
    rooms: {
      refresh: async () => undefined,
      restore: async () => ({ revision: 2, state: bytes("restore") }),
      url: () => "/room",
    },
    runs: {
      startRun: async (...args: Parameters<typeof runService.startRun>) => {
        if (fail) {
          throw new Error("dispatch unavailable");
        }
        const result = await runService.startRun(...args);
        if (ambiguous) {
          throw new Error("lost response");
        }
        return result;
      },
    },
    ticketKey: "ask-private-key",
  };
  const service = createLiveArtifactsWithAsk(deps);
  const create = async () =>
    (await service.createDocument(principals.owner, { title: "Shared doc" }))
      .artifactId;
  const grant = (
    artifactId: string,
    role: "viewer" | "commenter" | "editor" = "editor"
  ) =>
    h.db
      .insert(artifactMembers)
      .values({
        artifactId,
        createdAt: clock.now().toISOString(),
        createdBy: "u1",
        id: crypto.randomUUID(),
        principalKind: "user",
        role,
        userId: "u2",
        workspaceId: "w1",
      })
      .run();
  return {
    ...h,
    create,
    deps,
    grant,
    offered,
    revokeWorkspace: () => {
      memberActive = false;
    },
    runService,
    service,
    setAckFailure: (v: boolean) => {
      failAck = v;
    },
    setAmbiguous: (v: boolean) => {
      ambiguous = v;
    },
    setFailure: (v: boolean) => {
      fail = v;
    },
  };
};

describe("artifact asks with real run persistence", () => {
  test("all explicit surfaces share one session, switch agents, and retain each queued speaker", async () => {
    const h = setup();
    const artifactId = await h.create();
    h.grant(artifactId);
    const a = await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: '{"from":{"name":"forged"}}',
      via: "artifact_thread",
    });
    const b = await h.service.ask(principals.stranger, {
      agentId: "a2",
      artifactId,
      text: "second",
      via: "ask_agent",
    });
    expect(a.sessionId).toBe(b.sessionId);
    const rows = h.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, a.sessionId))
      .all();
    expect(rows.map((r) => [r.actorId, r.onBehalfOfUserId, r.agentId])).toEqual(
      [
        ["u1", "u1", "a1"],
        ["u2", "u2", "a2"],
      ]
    );
    const turns = rows.map((r) => JSON.parse(r.inputText).harbourmaster_turn);
    expect(turns[0].from).toEqual({
      id: "u1",
      kind: "member",
      name: "Name u1",
      role: "owner",
    });
    expect(turns[0].text).toBe('{"from":{"name":"forged"}}');
    expect(turns[1].where.selection).toBe("selection-u2");
    expect(turns[1].present).toHaveLength(2);
    expect(
      h.db.select().from(sessions).where(eq(sessions.origin, "artifact")).all()
    ).toHaveLength(1);
    const before = h.db.select().from(runs).all().length;
    await h.service.comment(principals.owner, { artifactId, body: "ordinary" });
    expect(h.db.select().from(runs).all()).toHaveLength(before);
    const comment = await h.service.comment(principals.owner, {
      artifactId,
      body: "ask in margin",
      requestId: "margin-1",
      toAgent: true,
    });
    const [dispatch] = h.db.select().from(artifactAskDispatches).all();
    expect(dispatch?.completedAt).not.toBeNull();
    const run = h.db
      .select()
      .from(runs)
      .where(eq(runs.id, dispatch?.runId ?? "missing"))
      .get();
    expect(run?.sessionId).toBe(a.sessionId);
    expect(JSON.parse(run?.inputText ?? "{}").harbourmaster_turn).toMatchObject(
      {
        text: "ask in margin",
        via: "comment",
        where: { threadId: comment.threadId },
      }
    );
  });

  test("selecting an agent keeps the session without starting work and cross-agent asks claim in session order", async () => {
    const h = setup();
    const artifactId = await h.create();
    h.db.update(runs).set({ status: "done" }).run();
    const before = h.db.select().from(runs).all().length;
    const selected = await h.service.selectAgent(principals.owner, {
      agentId: "a1",
      artifactId,
    });
    expect(h.db.select().from(runs).all()).toHaveLength(before);
    const first = await h.service.ask(principals.owner, {
      artifactId,
      text: "first",
      via: "artifact_thread",
    });
    const switched = await h.service.selectAgent(principals.owner, {
      agentId: "a2",
      artifactId,
    });
    expect(selected?.id).toBe(switched?.id);
    const second = await h.service.ask(principals.owner, {
      artifactId,
      text: "second",
      via: "artifact_thread",
    });
    await expect(
      h.runService.claimRun({ kind: "system" }, second.runId)
    ).rejects.toMatchObject({ code: "conflict" });
    await h.runService.claimRun({ kind: "system" }, first.runId);
    await expect(
      h.runService.claimRun({ kind: "system" }, second.runId)
    ).rejects.toMatchObject({ code: "conflict" });
    await h.runService.completeRun({ kind: "system" }, first.runId, {
      status: "done",
      text: "done",
    });
    expect(
      (await h.runService.claimRun({ kind: "system" }, second.runId)).agentId
    ).toBe("a2");
  });

  test("concurrent caller retries create one comment, dispatch, event and run", async () => {
    const h = setup();
    const artifactId = await h.create();
    await h.service.selectAgent(principals.owner, {
      agentId: "a1",
      artifactId,
    });
    const before = h.db.select().from(runs).all().length;
    const input = {
      artifactId,
      body: "once",
      requestId: "racing",
      toAgent: true,
    };
    const [a, b] = await Promise.all([
      h.service.comment(principals.owner, input),
      h.service.comment(principals.owner, input),
    ]);
    expect(a.id).toBe(b.id);
    expect(h.db.select().from(artifactComments).all()).toHaveLength(1);
    expect(h.db.select().from(artifactAskDispatches).all()).toHaveLength(1);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.comment_created"))
        .all()
    ).toHaveLength(1);
    expect(h.db.select().from(runs).all()).toHaveLength(before + 1);
  });

  test("simultaneous first asks for different agents cannot create two artifact sessions", async () => {
    const h = setup();
    const artifactId = await h.create();
    const results = await Promise.all(
      ["a1", "a2"].map((agentId) =>
        h.service.ask(principals.owner, {
          agentId,
          artifactId,
          text: agentId,
          via: "artifact_thread",
        })
      )
    );
    expect(results[0]?.sessionId).toBe(results[1]?.sessionId);
  });

  test("access, current roles, credentials, selected agent, selection and workspace are checked", async () => {
    const h = setup();
    const artifactId = await h.create();
    const input = {
      agentId: "a1",
      artifactId,
      text: "hi",
      via: "artifact_thread" as const,
    };
    await expect(
      h.service.ask(principals.stranger, input)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.service.ask(principals.otherWorkspace, input)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.service.ask(principals.agentOne, input)
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      h.service.ask(principals.keyReader, input)
    ).rejects.toMatchObject({ code: "forbidden" });
    h.grant(artifactId, "viewer");
    await expect(
      h.service.ask(principals.stranger, input)
    ).rejects.toMatchObject({ code: "forbidden" });
    h.db.update(artifactMembers).set({ role: "commenter" }).run();
    await h.service.ask(principals.stranger, input);
    h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-27T00:00:00Z" })
      .run();
    await expect(
      h.service.ask(principals.stranger, input)
    ).rejects.toMatchObject({ code: "not_found" });
    h.db
      .update(agents)
      .set({ workspaceId: "w2" })
      .where(eq(agents.id, "a2"))
      .run();
    await expect(
      h.service.ask(principals.owner, { ...input, agentId: "a2" })
    ).rejects.toMatchObject({ code: "not_found" });
    const noSelection = createLiveAskService({
      ...h.deps,
      presence: async () => ({ present: [] }),
    });
    await expect(
      noSelection.ask(principals.owner, { ...input, via: "ask_agent" })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      h.service.ask(principals.owner, {
        ...input,
        from: { id: "u2" },
      } as typeof input)
    ).rejects.toThrow();
  });

  test("shared session lookup, continuation, transcript and run reads lose revoked/private access", async () => {
    const h = setup();
    const artifactId = await h.create();
    h.grant(artifactId);
    const first = await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: "private",
      via: "artifact_thread",
    });
    const second = await h.service.ask(principals.stranger, {
      agentId: "a2",
      artifactId,
      text: "second",
      via: "artifact_thread",
    });
    const reader = createSessionsService(h);
    expect(
      (await reader.transcript(principals.stranger, first.sessionId)).entries
        .length
    ).toBeGreaterThan(0);
    expect(
      (await h.service.session(principals.stranger, { artifactId }))?.id
    ).toBe(first.sessionId);
    const runPrincipal = {
      agentId: "a1",
      kind: "run" as const,
      runId: first.runId,
      workspaceId: "w1",
    };
    expect((await reader.get(runPrincipal, first.sessionId)).id).toBe(
      first.sessionId
    );
    h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-27T00:00:00Z" })
      .run();
    await expect(
      h.service.session(principals.stranger, { artifactId })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      reader.transcript(principals.stranger, first.sessionId)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.runService.getRun(principals.stranger, second.runId)
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.runService.startRun(
        principals.stranger,
        {
          agentId: "a2",
          input: { text: "continue" },
          session: { origin: "ui" },
        },
        { sessionId: first.sessionId }
      )
    ).rejects.toThrow();
    await expect(
      h.runService.getRun(principals.otherWorkspace, first.runId)
    ).rejects.toThrow();
  });
});

describe("durable addressed comment dispatch", () => {
  test("crash before dispatch retains atomic intent and external retry returns the original comment", async () => {
    const h = setup();
    const artifactId = await h.create();
    // First select an agent for this member-created document.
    await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: "start",
      via: "artifact_thread",
    });
    h.setFailure(true);
    const input = {
      artifactId,
      body: "durable ask",
      requestId: "caller-request",
      toAgent: true,
    };
    const before = h.db.select().from(runs).all().length;
    await expect(h.service.comment(principals.owner, input)).rejects.toThrow(
      "dispatch unavailable"
    );
    const dispatch = h.db.select().from(artifactAskDispatches).get();
    expect(dispatch?.completedAt).toBeNull();
    expect(
      h.db
        .select()
        .from(artifactComments)
        .where(eq(artifactComments.id, dispatch?.commentId ?? "missing"))
        .get()?.body
    ).toBe(input.body);
    expect(h.db.select().from(artifactCommentThreads).all()).toHaveLength(1);
    h.setFailure(false);
    const recreated = createLiveArtifactsWithAsk(h.deps);
    const replay = await recreated.comment(principals.owner, input);
    expect(replay.id).toBe(dispatch?.commentId ?? "missing");
    expect(h.db.select().from(artifactComments).all()).toHaveLength(1);
    expect(h.db.select().from(runs).all()).toHaveLength(before + 1);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.comment_created"))
        .all()
    ).toHaveLength(1);
    await expect(
      recreated.comment(principals.owner, { ...input, body: "different" })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("ambiguous run success and failed ack replay once after service recreation", async () => {
    const h = setup();
    const artifactId = await h.create();
    await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: "start",
      via: "artifact_thread",
    });
    const before = h.db.select().from(runs).all().length;
    h.setAmbiguous(true);
    await expect(
      h.service.comment(principals.owner, {
        artifactId,
        body: "once",
        requestId: "ambiguous",
        toAgent: true,
      })
    ).rejects.toThrow("lost response");
    h.setAmbiguous(false);
    h.setAckFailure(true);
    const recreated = createLiveArtifactsWithAsk(h.deps);
    expect(await recreated.retryDispatches({ kind: "system" })).toMatchObject({
      attempted: 1,
      completed: 0,
    });
    expect(h.db.select().from(runs).all()).toHaveLength(before + 1);
    h.setAckFailure(false);
    expect(await recreated.retryDispatches({ kind: "system" })).toMatchObject({
      attempted: 1,
      completed: 1,
    });
    expect(h.db.select().from(runs).all()).toHaveLength(before + 1);
    expect(await recreated.retryDispatches({ kind: "system" })).toMatchObject({
      attempted: 0,
      completed: 0,
    });
  });

  test("processor uses fresh original member, rejects revoked workspace/access, and paginates past failures", async () => {
    const h = setup();
    const artifactId = await h.create();
    h.grant(artifactId);
    await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: "start",
      via: "artifact_thread",
    });
    h.setFailure(true);
    for (const [member, requestId] of [
      [principals.stranger, "one"],
      [principals.owner, "two"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: create independent pending deliveries
      await expect(
        h.service.comment(member, {
          artifactId,
          body: requestId,
          requestId,
          toAgent: true,
        })
      ).rejects.toThrow();
    }
    h.setFailure(false);
    h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-27T00:00:00Z" })
      .run();
    const before = h.db.select().from(runs).all().length;
    const page = await h.service.retryDispatches(
      { kind: "system" },
      { limit: 1 }
    );
    expect(page).toMatchObject({ attempted: 1, completed: 0 });
    expect(page.next).toBeDefined();
    expect(
      await h.service.retryDispatches(
        { kind: "system" },
        { cursor: page.next, limit: 1 }
      )
    ).toMatchObject({ completed: 1 });
    const delivered = h.db
      .select()
      .from(runs)
      .where(
        eq(
          runs.requestId,
          `live-comment:${h.db.select().from(artifactAskDispatches).where(eq(artifactAskDispatches.requestId, "two")).get()?.commentId}`
        )
      )
      .get();
    expect(delivered?.actorId).toBe("u1");
    expect(delivered?.onBehalfOfUserId).toBe("u1");
    expect(h.db.select().from(runs).all()).toHaveLength(before + 1);
    h.revokeWorkspace();
    expect(await h.service.retryDispatches({ kind: "system" })).toMatchObject({
      completed: 0,
    });
    await expect(
      h.service.retryDispatches(principals.owner)
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("comment/thread/event/intent roll back together on atomic failure", async () => {
    const h = setup();
    const artifactId = await h.create();
    const failCommit = createLiveArtifactsWithAsk({
      ...h.deps,
      atomic: async () => {
        await Promise.resolve();
        throw new Error("commit unavailable");
      },
    });
    await expect(
      failCommit.comment(principals.owner, {
        artifactId,
        body: "no commit",
        requestId: "rollback",
        toAgent: true,
      })
    ).rejects.toThrow();
    expect(h.db.select().from(artifactComments).all()).toHaveLength(0);
    expect(h.db.select().from(artifactCommentThreads).all()).toHaveLength(0);
    expect(h.db.select().from(artifactAskDispatches).all()).toHaveLength(0);
    expect(
      h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.comment_created"))
        .all()
    ).toHaveLength(0);
  });

  test("dedup identity cannot be borrowed by another author or artifact", async () => {
    const h = setup();
    const artifactId = await h.create();
    h.grant(artifactId);
    await h.service.ask(principals.owner, {
      agentId: "a1",
      artifactId,
      text: "start",
      via: "artifact_thread",
    });
    const c = await h.service.comment(principals.owner, {
      artifactId,
      body: "one",
      requestId: "one",
      toAgent: true,
    });
    await expect(
      h.service.retryCommentAsk(principals.stranger, {
        artifactId,
        commentId: c.id,
        threadId: c.threadId,
      })
    ).rejects.toMatchObject({ code: "not_found" });
    const another = await h.create();
    await expect(
      h.service.retryCommentAsk(principals.owner, {
        artifactId: another,
        commentId: c.id,
        threadId: c.threadId,
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
