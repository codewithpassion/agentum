import { beforeEach, describe, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  authorize,
  can,
  ForbiddenError,
  isForbiddenError,
  type Resource,
} from "./authz.ts";
import { createEventsService } from "./events.ts";
import type { Principal, WorkspacePrincipal } from "./workspaces.ts";

const resource = (workspaceId: string): Resource => ({
  kind: "event",
  workspaceId,
});

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Workspaces A and B, plus the agent and session that B's event points at,
 * so the event insert passes its foreign keys.
 */
const seedWorkspaces = (db: ReturnType<typeof migrated>) => {
  for (const id of ["wA", "wB"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  db.insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u-b",
      id: "a-b",
      instructions: "",
      model: "m",
      name: "B agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "b-agent",
      status: "active",
      workspaceId: "wB",
    })
    .run();
  db.insert(sessions)
    .values({
      actorId: "u-b",
      actorKind: "user",
      agentId: "a-b",
      createdAt: NOW,
      id: "s-b",
      origin: "test",
      workspaceId: "wB",
    })
    .run();
};

const workspacePrincipals = (workspaceId: string): WorkspacePrincipal[] => [
  { kind: "user", userId: "u1", via: "session", workspaceId },
  { agentId: "a1", kind: "run", runId: "r1", workspaceId },
  { kind: "machine", machineId: "m1", workspaceId },
  { agentId: "a1", kind: "trigger", triggerId: "t1", workspaceId },
];

describe("can", () => {
  for (const principal of workspacePrincipals("wA")) {
    test(`a ${principal.kind} principal may act in its own workspace`, () => {
      expect(can(principal, "events.read", resource("wA"))).toBe(true);
    });

    test(`a ${principal.kind} principal may not act in another workspace`, () => {
      expect(can(principal, "events.read", resource("wB"))).toBe(false);
    });
  }

  test("the system principal may act in any workspace", () => {
    const system: Principal = { kind: "system" };
    expect(can(system, "events.read", resource("wA"))).toBe(true);
    expect(can(system, "events.read", resource("wB"))).toBe(true);
  });

  describe("a peer principal reached through an A2A connection", () => {
    const peer: Principal = {
      agentId: "a1",
      connectionId: "c1",
      kind: "peer",
      workspaceId: "wA",
    };

    for (const action of ["a2a.task.read", "runs.start"]) {
      test(`may ${action} in its own workspace`, () => {
        expect(can(peer, action, resource("wA"))).toBe(true);
      });

      test(`may not ${action} in another workspace`, () => {
        expect(can(peer, action, resource("wB"))).toBe(false);
      });
    }

    for (const action of [
      "runs.read",
      "events.read",
      "agents.read",
      "a2a",
      "a2ax.read",
      "sessions.read",
    ]) {
      test(`may not ${action} in its own workspace`, () => {
        expect(can(peer, action, resource("wA"))).toBe(false);
      });
    }
  });
});

describe("authorize", () => {
  test("does nothing when can allows the action", () => {
    const [principal] = workspacePrincipals("wA");
    expect(principal).toBeDefined();
    if (!principal) {
      return;
    }
    expect(() =>
      authorize(principal, "events.read", resource("wA"))
    ).not.toThrow();
  });

  test("throws ForbiddenError when can denies the action", () => {
    const [principal] = workspacePrincipals("wA");
    if (!principal) {
      throw new Error("no principal");
    }
    let caught: unknown;
    try {
      authorize(principal, "events.read", resource("wB"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(isForbiddenError(caught)).toBe(true);
    expect((caught as ForbiddenError).name).toBe("ForbiddenError");
    expect((caught as ForbiddenError).code).toBe("forbidden");
    expect((caught as ForbiddenError).message).toBe("Not allowed: events.read");
  });

  test("isForbiddenError rejects other errors", () => {
    expect(isForbiddenError(new Error("nope"))).toBe(false);
    expect(isForbiddenError(undefined)).toBe(false);
  });
});

describe("a member of A cannot read B's row through any service", () => {
  const a: Principal = {
    kind: "user",
    userId: "u-a",
    via: "session",
    workspaceId: "wA",
  };
  const b: Principal = {
    kind: "user",
    userId: "u-b",
    via: "session",
    workspaceId: "wB",
  };

  let service: ReturnType<typeof createEventsService>;
  let bEvent: Awaited<ReturnType<typeof service.append>>;

  beforeEach(async () => {
    const db = migrated();
    seedWorkspaces(db);
    const store = new Map<string, string>();
    service = createEventsService({
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      db,
    });
    bEvent = await service.append({
      actor: { id: "u-b", kind: "user" },
      payload: { text: "B's secret" },
      sessionId: "s-b",
      type: "message.user",
      workspaceId: "wB",
    });
  });

  test("transcript, query and readPayload reject A's principal for B's workspace", async () => {
    await expect(service.transcript(a, "wB", "s-b")).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(service.query(a, "wB")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.readPayload(a, bEvent)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  test("the workspace filter alone returns nothing for A's own workspace", async () => {
    expect(await service.transcript(a, "wA", "s-b")).toEqual([]);
    expect(await service.query(a, "wA")).toEqual([]);
  });

  test("B's own principal reads the event", async () => {
    const transcript = await service.transcript(b, "wB", "s-b");
    expect(transcript.map((e) => e.id)).toEqual([bEvent.id]);
    expect((await service.query(b, "wB")).map((e) => e.id)).toEqual([
      bEvent.id,
    ]);
    expect(await service.readPayload(b, bEvent)).toEqual({
      text: "B's secret",
    });
  });
});
