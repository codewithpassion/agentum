import { expect, test } from "bun:test";
import { canSend, threadWaits } from "./inbox-logic.ts";

test("send is allowed only for non-blank text while not already sending", () => {
  expect(canSend("hello", false)).toBe(true);
  expect(canSend("   \n\t", false)).toBe(false);
  expect(canSend("", false)).toBe(false);
  expect(canSend("hello", true)).toBe(false);
});

const agentPost = {
  authorKind: "agent",
  createdAt: "2026-11-02T10:00:00.000Z",
} as const;
const personPost = {
  authorKind: "user",
  createdAt: "2026-11-02T11:00:00.000Z",
} as const;

test("a thread waits when its newest post is an agent's and never dismissed", () => {
  expect(
    threadWaits({ attentionClearedAt: null }, [personPost, agentPost])
  ).toBe(true);
});

test("a thread does not wait when a person posted last", () => {
  expect(
    threadWaits({ attentionClearedAt: null }, [agentPost, personPost])
  ).toBe(false);
});

test("a dismissal at or after the agent's post hides the thread", () => {
  expect(
    threadWaits({ attentionClearedAt: "2026-11-02T10:00:00.000Z" }, [agentPost])
  ).toBe(false);
  expect(
    threadWaits({ attentionClearedAt: "2026-11-02T10:30:00.000Z" }, [agentPost])
  ).toBe(false);
});

test("a dismissal before a newer agent post lets the thread wait again", () => {
  const newerAgentPost = {
    authorKind: "agent",
    createdAt: "2026-11-02T12:00:00.000Z",
  } as const;
  expect(
    threadWaits({ attentionClearedAt: "2026-11-02T10:30:00.000Z" }, [
      agentPost,
      newerAgentPost,
    ])
  ).toBe(true);
});

test("a thread with no posts does not wait", () => {
  expect(threadWaits({ attentionClearedAt: null }, [])).toBe(false);
});
