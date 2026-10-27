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
  get: () => caller.artifacts.get({ artifactId }),
  list: () => caller.artifacts.list({}),
  open: () => caller.artifacts.open({ artifactId, surface: "viewer" }),
  remove: () => caller.artifacts.remove({ artifactId }),
  rename: () => caller.artifacts.rename({ artifactId, title: "x" }),
  restore: () => caller.artifacts.restore({ artifactId, version: 1 }),
  revokeShare: () => caller.artifacts.revokeShare({ shareId: "x" }),
  setAudience: () =>
    caller.artifacts.setAudience({ artifactId, audience: "private" }),
  setLinksEnabled: () => caller.artifacts.setLinksEnabled({ enabled: true }),
  shares: () => caller.artifacts.shares({ artifactId }),
  versions: () => caller.artifacts.versions({ artifactId }),
  views: () => caller.artifacts.views({ artifactId }),
};

test("every artifacts procedure is stubbed as NOT_IMPLEMENTED", async () => {
  expect(Object.keys(calls)).toHaveLength(14);
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
