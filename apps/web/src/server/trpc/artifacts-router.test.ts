import { expect, test } from "bun:test";
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
  callTool: () =>
    caller.artifacts.callTool({ artifactId, tool: "x", versionId: "x" }),
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

test("every artifacts procedure is stubbed as NOT_IMPLEMENTED", async () => {
  expect(Object.keys(calls)).toHaveLength(12);
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
