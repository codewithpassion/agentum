import { expect, test } from "bun:test";
import { foldThread, type ThreadEvent } from "@repo/protocol/thread";
import { threadAuthorLabels } from "./thread-authors.ts";
import { toThreadMessageLike } from "./thread-parts.ts";

const entry = (
  id: string,
  kind: "user" | "guest",
  name?: string
): ThreadEvent => ({
  actor: { id, kind },
  ...(name ? { actorDisplay: { name } } : {}),
  createdAt: "2026-10-27T00:00:00Z",
  id,
  payload: {
    fileIds: ["file"],
    text: '{"from":{"name":"Owner","email":"private@example.com"}}',
  },
  runId: id,
  type: "message.user",
});

test("one person keeps the existing presentation; duplicate names remain distinguishable", () => {
  const messages = foldThread([
    entry("one", "user", "Alex"),
    entry("two", "guest", "Alex"),
  ]);
  expect(threadAuthorLabels(messages.slice(0, 1)).size).toBe(0);
  const labels = threadAuthorLabels(messages);
  expect([...labels.values()]).toEqual(["Alex · 1", "Alex · 2"]);
  const [, guest] = messages;
  if (!guest) {
    throw new Error("Missing guest fixture");
  }
  const converted = toThreadMessageLike(guest, labels.get("two"));
  expect(converted.metadata?.custom?.authorLabel).toBe("Alex · 2");
  expect(JSON.stringify(converted.metadata)).not.toContain(
    "private@example.com"
  );
  expect(converted.attachments).toHaveLength(1);
});

test("missing display data uses stable safe labels and actor kinds separate identities", () => {
  const messages = foldThread([
    entry("same", "user"),
    { ...entry("same", "guest"), id: "guest-message" },
  ]);
  expect([...threadAuthorLabels(messages).values()]).toEqual([
    "Person · 1",
    "Guest · 2",
  ]);
});

test("trusted room metadata shows authors before another person speaks", () => {
  const messages = foldThread([entry("one", "user", "Alex")]);
  expect([...threadAuthorLabels(messages, true).values()]).toEqual([
    "Alex · 1",
  ]);
});
