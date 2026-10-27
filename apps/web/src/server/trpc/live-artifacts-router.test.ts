import { expect, test } from "bun:test";
import { ForbiddenError } from "@repo/services/authz";
import { ServiceError } from "@repo/services/errors";
import type { LiveArtifactsWithAsk } from "@repo/services/live-artifacts/factory";
import type { Context } from "./context.ts";
import { createLiveArtifactsRouter } from "./live-artifacts-router.ts";

const principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
const artifactId = crypto.randomUUID();
const inputs = {
  answered: { threadId: "thread" },
  ask: { artifactId, text: "hello", via: "artifact_thread" },
  changes: { artifactId },
  checkpoint: { artifactId, revision: 1, state: new Uint8Array([1]) },
  comment: { artifactId, body: "Hi" },
  convertDoc: { artifactId },
  createDocument: { title: "Doc" },
  invalidateAccess: { artifactId },
  join: { artifactId },
  recordChange: {
    artifactId,
    revFrom: 1,
    revTo: 2,
    summary: "edit",
    toolCallId: "call",
  },
  remove: { artifactId },
  resolve: { threadId: "thread" },
  restore: { artifactId, version: 1 },
  retryCommentAsk: { artifactId, commentId: "comment", threadId: "thread" },
  revertChange: { changeId: "change" },
  selectAgent: { agentId: "agent", artifactId },
  session: { artifactId },
  setAudience: { artifactId, audience: "private" },
  threads: { artifactId },
} as const;
const create = (
  member: Context["principal"],
  method: (principal: unknown, input: unknown) => Promise<unknown>
) => {
  const service = Object.fromEntries(
    Object.keys(inputs).map((name) => [name, method])
  ) as unknown as LiveArtifactsWithAsk;
  return createLiveArtifactsRouter(() => service).createCaller({
    principal: member,
    services: {},
  } as Context);
};

test("every browser method requires authenticated workspace membership (401)", async () => {
  for (const member of [
    null,
    { kind: "system" } as const,
    { agentId: "a", kind: "run", runId: "r", workspaceId: "w" } as const,
  ]) {
    const caller = create(member, async () => {
      await Promise.resolve();
      throw new Error("must not reach service");
    });
    for (const [name, input] of Object.entries(inputs)) {
      // biome-ignore lint/performance/noAwaitInLoops: cover each public procedure
      await expect(
        (
          caller[name as keyof typeof inputs] as (
            value: unknown
          ) => Promise<unknown>
        )(input)
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  }
});

test("every browser method maps current service authorization to 403 and hidden access to 404", async () => {
  for (const [error, code] of [
    [new ForbiddenError("current role"), "FORBIDDEN"],
    [new ServiceError("not_found", "Not found"), "NOT_FOUND"],
  ] as const) {
    const caller = create(principal, async () => {
      await Promise.resolve();
      throw error;
    });
    for (const [name, input] of Object.entries(inputs)) {
      // biome-ignore lint/performance/noAwaitInLoops: cover each public procedure
      await expect(
        (
          caller[name as keyof typeof inputs] as (
            value: unknown
          ) => Promise<unknown>
        )(input)
      ).rejects.toMatchObject({ code });
    }
  }
});

test("thin procedures pass the authenticated principal and validated input exactly once", async () => {
  const calls: unknown[][] = [];
  const caller = create(principal, async (...args) => {
    await Promise.resolve();
    calls.push(args);
    return null;
  });
  for (const [name, input] of Object.entries(inputs)) {
    // biome-ignore lint/performance/noAwaitInLoops: cover each public procedure
    await (
      caller[name as keyof typeof inputs] as (
        value: unknown
      ) => Promise<unknown>
    )(input);
    expect(calls.at(-1)).toEqual([principal, input]);
  }
  expect(calls).toHaveLength(Object.keys(inputs).length);
});

test("strict ask/comment schemas reject client speaker, roster, presence, selection and unsafe ids", async () => {
  let called = false;
  const caller = create(principal, async () => {
    await Promise.resolve();
    called = true;
    return null;
  });
  for (const field of [
    "from",
    "authorId",
    "role",
    "where",
    "selection",
    "present",
    "sessionId",
    "workspaceId",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each forbidden field must fail before service call
    await expect(
      caller.ask({ ...inputs.ask, [field]: "forged" } as typeof inputs.ask)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.comment({
        ...inputs.comment,
        [field]: "forged",
      } as typeof inputs.comment)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  await expect(
    caller.ask({ ...inputs.ask, artifactId: "invalid" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.threads({ artifactId, limit: 101 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(called).toBe(false);
});
