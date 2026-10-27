import { agents } from "@repo/db/schema/agents";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { bytes, harness, principals } from "../artifacts/test-harness.ts";
import { createRunsService } from "../runs.ts";
import type { Principal } from "../workspaces.ts";
import { createLiveArtifactsWithAsk } from "./factory.ts";

export const interactionFixture = () => {
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
    changes: {
      revert: async (_scope: unknown, input: { byParticipant: string }) => ({
        byParticipant: input.byParticipant,
        revision: 10,
      }),
    },
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
