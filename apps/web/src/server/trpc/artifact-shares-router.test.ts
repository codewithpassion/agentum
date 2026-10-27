import { describe, expect, test } from "bun:test";
import { ForbiddenError } from "@repo/services/authz";
import { ServiceError } from "@repo/services/errors";
import type { Context } from "./context.ts";
import { appRouter } from "./router.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;

const artifactId = crypto.randomUUID();
const shareId = "share-1";
const timestamp = "2026-10-27T10:00:00.000Z";

const share = {
  artifactId,
  createdAt: timestamp,
  createdBy: "u",
  dataMode: "snapshot",
  expiresAt: null,
  grantedBy: null,
  id: shareId,
  lastOpenedAt: null,
  liveTools: null,
  openCount: 0,
  revokedAt: null,
  status: "active",
  url: "https://example.test/s/share-1",
  versionId: null,
} as const;

const opened = {
  contentUrl: "https://example.test/content/share-1",
  expiresAt: timestamp,
  version: { createdAt: timestamp, number: 1 },
};

const view = {
  artifactId,
  asn: null,
  asOrg: null,
  city: null,
  country: null,
  createdAt: timestamp,
  id: "view-1",
  ipPrefix: null,
  outcome: "ok",
  referrerHost: null,
  region: null,
  shareId,
  surface: "viewer",
  toolKey: null,
  userAgent: null,
  userId: "u",
  versionId: null,
} as const;

const viewsPage = { items: [view] };

const openInput = { artifactId, surface: "viewer" } as const;
const sharesInput = { artifactId } as const;
const createShareInput = { artifactId } as const;
const revokeShareInput = { shareId } as const;
const viewsInput = { artifactId, shareId } as const;
const setLinksEnabledInput = { enabled: false } as const;

/**
 * A hand-written stand-in for the shares service. Every method records its
 * arguments and answers with a value valid for the procedure's output schema.
 * With `failure`, every method rejects with it instead.
 */
const fakeShares = (failure?: unknown) => {
  const received: { args: unknown[]; method: string }[] = [];
  const answer =
    <T>(method: string, value: T) =>
    (...args: unknown[]) => {
      received.push({ args, method });
      return failure === undefined
        ? Promise.resolve(value)
        : Promise.reject(failure);
    };
  const service = {
    createShare: answer("createShare", share),
    open: answer("open", opened),
    revokeShare: answer("revokeShare", undefined),
    setLinksEnabled: answer("setLinksEnabled", undefined),
    shares: answer("shares", [share]),
    views: answer("views", viewsPage),
  };
  return { received, service };
};

const callerWith = (services: object) =>
  appRouter.createCaller({
    principal,
    services,
  } as unknown as Context);

type Caller = ReturnType<typeof callerWith>;

const procedures: {
  expected: unknown;
  method: string;
  run: (caller: Caller) => Promise<unknown>;
  expectedInput: unknown;
}[] = [
  {
    expected: opened,
    expectedInput: openInput,
    method: "open",
    run: (caller) => caller.artifacts.open(openInput),
  },
  {
    expected: [share],
    expectedInput: sharesInput,
    method: "shares",
    run: (caller) => caller.artifacts.shares(sharesInput),
  },
  {
    expected: share,
    // The input schema fills in the default data mode.
    expectedInput: { artifactId, dataMode: "snapshot" },
    method: "createShare",
    run: (caller) => caller.artifacts.createShare(createShareInput),
  },
  {
    expected: {},
    expectedInput: revokeShareInput,
    method: "revokeShare",
    run: (caller) => caller.artifacts.revokeShare(revokeShareInput),
  },
  {
    expected: viewsPage,
    expectedInput: viewsInput,
    method: "views",
    run: (caller) => caller.artifacts.views(viewsInput),
  },
  {
    expected: {},
    expectedInput: setLinksEnabledInput,
    method: "setLinksEnabled",
    run: (caller) => caller.artifacts.setLinksEnabled(setLinksEnabledInput),
  },
];

describe("artifact shares procedures call the service", () => {
  test.each(procedures)(
    "$method passes the principal and parsed input, and returns the output",
    async ({ expected, expectedInput, method, run }) => {
      const { received, service } = fakeShares();

      const result = await run(callerWith({ artifactShares: service }));

      expect(received).toEqual([{ args: [principal, expectedInput], method }]);
      expect(result).toEqual(expected);
    }
  );

  test("an anonymous caller is unauthorized and never reaches the service", async () => {
    const { received, service } = fakeShares();
    const anonymous = appRouter.createCaller({
      principal: { kind: "anonymous" },
      services: { artifactShares: service },
    } as unknown as Context);

    await Promise.all(
      procedures.map(({ run, method }) =>
        expect(run(anonymous), method).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        })
      )
    );
    expect(received).toEqual([]);
  });

  test("with no service wired, every procedure is NOT_IMPLEMENTED", async () => {
    const unwired = callerWith({});

    await Promise.all(
      procedures.map(({ run, method }) =>
        expect(run(unwired), method).rejects.toMatchObject({
          code: "NOT_IMPLEMENTED",
        })
      )
    );
  });

  test("a ForbiddenError from the service maps to FORBIDDEN", async () => {
    const { service } = fakeShares(new ForbiddenError("x"));
    const caller = callerWith({ artifactShares: service });

    await Promise.all(
      procedures.map(({ run, method }) =>
        expect(run(caller), method).rejects.toMatchObject({
          code: "FORBIDDEN",
        })
      )
    );
  });

  test("a not_found ServiceError from the service maps to NOT_FOUND", async () => {
    const { service } = fakeShares(new ServiceError("not_found", "x"));
    const caller = callerWith({ artifactShares: service });

    await Promise.all(
      procedures.map(({ run, method }) =>
        expect(run(caller), method).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "x",
        })
      )
    );
  });

  test("a bad artifactId fails the input schema before the service runs", async () => {
    const { received, service } = fakeShares();
    const caller = callerWith({ artifactShares: service });
    const badId = "nope";

    await expect(
      caller.artifacts.open({ artifactId: badId, surface: "viewer" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.artifacts.shares({ artifactId: badId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.artifacts.createShare({ artifactId: badId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.artifacts.views({ artifactId: badId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(received).toEqual([]);
  });

  test("a live createShare without liveTools fails the input schema", async () => {
    const { received, service } = fakeShares();
    const caller = callerWith({ artifactShares: service });

    await expect(
      caller.artifacts.createShare({ artifactId, dataMode: "live" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(received).toEqual([]);
  });
});
