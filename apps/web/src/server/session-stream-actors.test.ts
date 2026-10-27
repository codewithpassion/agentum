import { expect, test } from "bun:test";
import { eventFrameSchema } from "@repo/protocol/stream";
import { applyFrame, foldThread } from "@repo/protocol/thread";
import type { EventRecord } from "@repo/services/events";
import { eventFrame } from "./session-stream-frames.ts";

test("history and parsed SSE retain the same trusted actors and names through the fold", () => {
  const records: EventRecord[] = ["user", "guest"].map((kind, index) => ({
    actor: { id: `person${index}`, kind: kind as "user" | "guest" },
    actorDisplay: { name: kind === "guest" ? "Ana" : "Dom" },
    agentId: "agent",
    createdAt: "2026-10-27T00:00:00.000Z",
    id: `event${index}`,
    payload: {
      actor: { id: "owner" },
      actorDisplay: { name: "FORGED" },
      text: "hello",
    },
    payloadRef: null,
    runId: `run${index}`,
    seq: null,
    sessionId: "session",
    type: "message.user",
    workspaceId: "workspace",
  }));
  const history = foldThread(records);
  const live = records.reduce(
    (messages, record) =>
      applyFrame(
        messages,
        eventFrameSchema.parse(JSON.parse(JSON.stringify(eventFrame(record))))
      ),
    [] as ReturnType<typeof foldThread>
  );
  expect(live).toEqual(history);
  expect(live.map((message) => message.actorDisplay)).toEqual([
    { name: "Dom" },
    { name: "Ana" },
  ]);
  expect(live.map((message) => message.actor)).toEqual(
    records.map((record) => record.actor)
  );
});
