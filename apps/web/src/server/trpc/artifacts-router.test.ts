import { expect, test } from "bun:test";
import { ArtifactCallError } from "@repo/services/artifacts/calls";
import type { Context } from "./context.ts";
import { appRouter } from "./router.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
const caller = appRouter.createCaller({
  principal,
  services: {},
} as unknown as Context);
const artifactId = crypto.randomUUID();

const calls: Record<string, () => Promise<unknown>> = {
  createShare: () => caller.artifacts.createShare({ artifactId }),
  decideGrant: () =>
    caller.artifacts.decideGrant({ decision: "approved", grantId: "x" }),
  handTo: () => caller.artifacts.handTo({ agentId: null, artifactId }),
  open: () => caller.artifacts.open({ artifactId, surface: "viewer" }),
  pin: () => caller.artifacts.pin({ artifactId, surface: "sidebar" }),
  promote: () => caller.artifacts.promote({ artifactId, versionId: "x" }),
  revokeShare: () => caller.artifacts.revokeShare({ shareId: "x" }),
  setLinksEnabled: () => caller.artifacts.setLinksEnabled({ enabled: true }),
  shares: () => caller.artifacts.shares({ artifactId }),
  unpin: () => caller.artifacts.unpin({ artifactId, surface: "sidebar" }),
  views: () => caller.artifacts.views({ artifactId }),
};

test("every artifacts procedure but callTool is stubbed as NOT_IMPLEMENTED", async () => {
  expect(Object.keys(calls)).toHaveLength(11);
  await Promise.all(
    Object.entries(calls).map(([name, call]) =>
      expect(call(), name).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" })
    )
  );
});

test("the input schema runs before the stub body", async () => {
  await expect(
    caller.artifacts.get({ artifactId: "nope" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an anonymous caller is unauthorized", async () => {
  const anonymous = appRouter.createCaller({
    principal: { kind: "anonymous" },
  } as unknown as Context);
  await expect(anonymous.artifacts.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("the merged router exposes both halves under artifacts", () => {
  const list: typeof appRouter.artifacts.list = appRouter.artifacts.list;
  const createShare: typeof appRouter.artifacts.createShare =
    appRouter.artifacts.createShare;
  expect(list).toBeDefined();
  expect(createShare).toBeDefined();
});

test("callTool maps the call errors to tRPC codes", async () => {
  const expected = {
    failed: "BAD_GATEWAY",
    needs_auth: "PRECONDITION_FAILED",
    not_granted: "FORBIDDEN",
    too_large: "PAYLOAD_TOO_LARGE",
  } as const;
  await Promise.all(
    Object.entries(expected).map(([code, trpcCode]) => {
      const failing = appRouter.createCaller({
        principal,
        services: {
          artifactCalls: {
            callTool: () =>
              Promise.reject(
                new ArtifactCallError(code as keyof typeof expected, "no")
              ),
          },
        },
      } as unknown as Context);
      return expect(
        failing.artifacts.callTool({
          artifactId,
          tool: "x/y",
          versionId: "x",
        }),
        code
      ).rejects.toMatchObject({ code: trpcCode });
    })
  );
});
