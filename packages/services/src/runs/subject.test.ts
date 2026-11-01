import { expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";
import { deriveSubject, eventActor } from "./subject.ts";

const peer = (
  overrides: { agentId?: string; hops?: number } = {}
): Extract<Principal, { kind: "peer" }> => ({
  agentId: "agent-a",
  connectionId: "conn-1",
  kind: "peer",
  workspaceId: "ws-1",
  ...overrides,
});

test("a peer acts as its connection", () => {
  expect(eventActor(peer())).toEqual({ id: "conn-1", kind: "peer" });
});

test("a peer's run has no parent and no person behind it", async () => {
  const db = migrated();
  expect(await deriveSubject(db, peer({ hops: 1 }), "agent-a")).toEqual({
    actor: { id: "conn-1", kind: "peer" },
    depth: 1,
    onBehalfOfUserId: null,
    parentRunId: null,
  });
});

test("only a run's start can be a wake: a peer's or a person's start ignores wakeOf", async () => {
  const db = migrated();
  const wakeOf = { connectionId: "conn-2" };
  const person: Principal = {
    isAdmin: false,
    kind: "user",
    userId: "user-1",
    via: "session",
    workspaceId: "ws-1",
  };

  expect(await deriveSubject(db, peer(), "agent-a", wakeOf)).toEqual({
    actor: { id: "conn-1", kind: "peer" },
    depth: 0,
    onBehalfOfUserId: null,
    parentRunId: null,
  });
  expect(await deriveSubject(db, person, "agent-a", wakeOf)).toEqual({
    actor: { id: "user-1", kind: "user" },
    depth: 0,
    onBehalfOfUserId: "user-1",
    parentRunId: null,
  });
});

test("a peer may only start runs on its own agent", async () => {
  const db = migrated();
  await expect(deriveSubject(db, peer(), "agent-b")).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("a peer's claimed hops become depth, clamped to the run tree", async () => {
  const db = migrated();
  const depthFor = async (hops: number | undefined) =>
    (await deriveSubject(db, peer({ hops }), "agent-a")).depth;

  expect(await depthFor(0)).toBe(0);
  expect(await depthFor(2)).toBe(2);
  expect(await depthFor(3)).toBe(3);
  expect(await depthFor(7)).toBe(3);
  expect(await depthFor(-1)).toBe(0);
  expect(await depthFor(1.9)).toBe(1);
  expect(await depthFor(undefined)).toBe(0);
  expect(await depthFor(Number.NaN)).toBe(0);
});
