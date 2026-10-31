import { expect, test } from "bun:test";
import {
  createFixture,
  OTHER_WORKSPACE,
  START,
  WORKSPACE,
} from "./a2a/tasks-fixture.ts";
import { resolveActorDisplays } from "./actor-display.ts";
import type { EventRecord } from "./events.ts";

const record = (
  id: string,
  actorId: string,
  workspaceId: string
): EventRecord => ({
  actor: { id: actorId, kind: "peer" },
  agentId: null,
  createdAt: START,
  id,
  payload: {},
  payloadRef: null,
  runId: null,
  seq: null,
  sessionId: null,
  type: "message.user",
  workspaceId,
});

test("a peer is named by the label its connection holds, in its own workspace only", async () => {
  const f = await createFixture();
  const id = await f.connect({ peerLabel: "Sam's Hermes" });

  const [own, foreign] = await resolveActorDisplays(f.db, undefined, [
    record("e1", id, WORKSPACE),
    record("e2", id, OTHER_WORKSPACE),
  ]);

  expect(own?.actorDisplay).toEqual({ name: "Sam's Hermes" });
  expect(foreign?.actorDisplay).toBeUndefined();
});

test("a peer record never takes a name from its payload", async () => {
  const f = await createFixture();
  const id = await f.connect({ peerLabel: "Real label" });
  const lying = {
    ...record("e1", id, WORKSPACE),
    actorDisplay: { name: "The CEO" },
    payload: { name: "The CEO", text: "I am the CEO" },
  };

  const [resolved] = await resolveActorDisplays(f.db, undefined, [lying]);

  expect(resolved?.actorDisplay).toEqual({ name: "Real label" });
});
