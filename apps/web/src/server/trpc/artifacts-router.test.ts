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

test("the input schema runs before the procedure body", async () => {
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

test("diagnostics use workspace auth and strict output schemas", async () => {
  const anonymous = appRouter.createCaller({
    principal: { kind: "anonymous" },
  } as unknown as Context);
  await expect(anonymous.artifacts.calls({ artifactId })).rejects.toMatchObject(
    { code: "UNAUTHORIZED" }
  );
  await expect(
    anonymous.artifacts.appErrors({ artifactId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const invalid = appRouter.createCaller({
    principal,
    services: {
      artifactEndpoints: {
        appErrors: () => Promise.resolve([{ message: "invalid" }]),
        calls: () => Promise.resolve({ items: [], visitorHash: "private" }),
      },
    },
  } as unknown as Context);
  await expect(invalid.artifacts.calls({ artifactId })).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
  });
  await expect(
    invalid.artifacts.appErrors({ artifactId })
  ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
});
