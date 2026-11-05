import { expect, spyOn, test } from "bun:test";
import { fakePorts } from "@repo/app-gateway/fakes";
import type { AppRuntimeInput } from "@repo/app-gateway/ports";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { mountEndpointRoutes } from "./endpoints.ts";

const setup = (failLogging = false, status = 200) => {
  const work: Promise<unknown>[] = [];
  const access: string[] = [];
  const active = new Set(["approved"]);
  const seen: AppRuntimeInput[] = [];
  const keys: string[] = [];
  const counts = new Map<string, number>();
  const logs: string[] = [];
  const metrics: { statusCode: number; durationMs: number }[] = [];
  let limited = false;
  const app = new Hono<AppEnv>();
  mountEndpointRoutes(app, {
    limiter: () => ({
      limit: ({ key }) => {
        keys.push(key);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return Promise.resolve({ success: !limited && count <= 300 });
      },
    }),
    wiring: () => ({
      declaresHosts: () => Promise.resolve(true),
      endpoints: {
        recordCall: (_id, _meta, outcome, measurement) => {
          metrics.push(measurement);
          logs.push(outcome);
          if (failLogging) {
            return Promise.reject(new Error("Logging unavailable"));
          }
          return Promise.resolve();
        },
        resolve: (id) => {
          access.push("resolve");
          return Promise.resolve(
            active.has(id)
              ? {
                  artifactId: "a",
                  endpointId: id,
                  name: "discord",
                  versionId: "v",
                  workspaceId: "w",
                }
              : null
          );
        },
      },
      ports: fakePorts(),
      requestMeta: () => {
        access.push("meta");
        return Promise.resolve({
          ipPrefix: null,
          place: null,
          userAgent: null,
          visitorHash: "h",
        });
      },
      runtime: {
        handle: (input) => {
          seen.push(input);
          return Promise.resolve(
            new Response(input.request.body, {
              headers: {
                "content-type": "application/octet-stream",
                "set-cookie": "evil",
              },
              status,
            })
          );
        },
      },
    }),
  });
  return {
    access,
    active,
    app,
    call: (path: string, init?: RequestInit) =>
      app.request(path, init, undefined, {
        passThroughOnException: () => undefined,
        props: {},
        waitUntil: (task: Promise<unknown>) => work.push(task),
      }),
    keys,
    limit: () => {
      limited = true;
    },
    logs,
    metrics,
    seen,
    work,
  };
};

test("unknown, disabled, missing and pending grant ids have the same fixed 404", async () => {
  const { app, seen, logs, access } = setup();
  await Promise.all(
    ["unknown", "disabled", "missing-grant", "pending"].map(async (id) => {
      const response = await app.request(`/hooks/${id}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found.");
    })
  );
  expect(seen).toHaveLength(0);
  expect(logs).toEqual([]);
  expect(access).not.toContain("meta");
});

test("raw bytes, suffix, query and authorization reach endpoint app; headers are filtered", async () => {
  const { app, seen, logs } = setup();
  const bytes = new Uint8Array([0, 255, 13, 10, 123, 32, 125]);
  const response = await app.request("/hooks/approved/discord?x=%2F&x=2", {
    body: bytes,
    headers: {
      authorization: "Bearer bot",
      "CF-Connecting-IP": "1.2.3.4",
      cookie: "session=secret",
      "x-forwarded-for": "private",
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const [input] = seen;
  if (!input) {
    throw new Error("App was not called");
  }
  const { request } = input;
  expect(new URL(request.url).pathname + new URL(request.url).search).toBe(
    "/discord?x=%2F&x=2"
  );
  expect(request.headers.get("authorization")).toBe("Bearer bot");
  for (const name of ["cookie", "cf-connecting-ip", "x-forwarded-for"]) {
    expect(request.headers.has(name)).toBe(false);
  }
  expect(input.host.viewer).toEqual({
    endpointId: "approved",
    kind: "endpoint",
  });
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("content-security-policy")).toBe(true);
  expect(logs).toEqual(["ok"]);
});

test("root and OPTIONS reach app; rotation closes old id; endpoint and IP limits give 429", async () => {
  const h = setup();
  expect(
    (await h.app.request("/hooks/approved", { method: "OPTIONS" })).status
  ).toBe(200);
  expect(
    new URL(h.seen[0]?.request.url ?? "https://missing.invalid").pathname
  ).toBe("/");
  h.active.delete("approved");
  h.active.add("rotated");
  expect((await h.app.request("/hooks/approved")).status).toBe(404);
  expect((await h.app.request("/hooks/rotated")).status).toBe(200);
  h.limit();
  expect(
    (
      await h.app.request("/hooks/rotated", {
        headers: { "CF-Connecting-IP": "1.2.3.4" },
      })
    ).status
  ).toBe(429);
  expect(h.keys).not.toContain("api:endpoint:rotated");
  expect(h.keys.some((key) => key.startsWith("api:endpoint:rotated:ip:"))).toBe(
    true
  );
  expect(h.logs).not.toContain("rate_limited");
});

test("HTTP ingress rechecks database grants and live versions; disable, enable and rotate apply immediately", async () => {
  const { migrated } = await import("@repo/db/test-db");
  const { sqliteAtomic } = await import("@repo/db/atomic");
  const {
    artifactEndpoints,
    artifactGrants,
    artifacts,
    artifactVersions,
    artifactViews,
  } = await import("@repo/db/schema/artifacts");
  const { createArtifactEndpointsService } = await import(
    "@repo/services/artifacts/endpoints"
  );
  const db = migrated(["org"]);
  const [workspace] = await db
    .select()
    .from((await import("@repo/db/schema/workspaces")).workspaces);
  if (!workspace) {
    throw new Error("Missing workspace");
  }
  const workspaceId = workspace.id;
  const now = new Date().toISOString();
  await db.insert(artifacts).values({
    audience: "workspace",
    createdAt: now,
    createdById: "owner",
    createdByKind: "user",
    currentVersionId: "version",
    id: "artifact",
    kind: "app",
    ownerUserId: "owner",
    title: "Bot",
    updatedAt: now,
    workspaceId,
  });
  await db.insert(artifactVersions).values({
    artifactId: "artifact",
    authorId: "owner",
    authorKind: "user",
    createdAt: now,
    entry: "index.html",
    fileCount: 1,
    id: "version",
    manifestKey: "m",
    message: "",
    number: 1,
    status: "published",
    totalBytes: 1,
    workspaceId,
  });
  const endpoints = createArtifactEndpointsService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(now) },
    db,
    errors: { list: () => Promise.resolve([]) },
  });
  await db.insert(artifactEndpoints).values({
    artifactId: "artifact",
    createdAt: now,
    id: "test-endpoint",
    name: "discord",
    workspaceId,
  });
  const owner = {
    kind: "user",
    userId: "owner",
    via: "session",
    workspaceId,
  } as const;
  const [endpoint] = await endpoints.list(owner, "artifact");
  if (!endpoint) {
    throw new Error("Missing endpoint");
  }
  const app = new Hono<AppEnv>();
  const ports = fakePorts();
  mountEndpointRoutes(app, {
    wiring: () => ({
      declaresHosts: () => Promise.resolve(true),
      endpoints,
      ports,
      requestMeta: () =>
        Promise.resolve({
          ipPrefix: null,
          place: null,
          userAgent: null,
          visitorHash: "h",
        }),
      runtime: { handle: () => Promise.resolve(new Response("app")) },
    }),
  });
  const work: Promise<unknown>[] = [];
  const call = (id = endpoint.id) =>
    app.request(`/hooks/${id}`, undefined, undefined, {
      passThroughOnException: () => undefined,
      props: {},
      waitUntil: (task: Promise<unknown>) => work.push(task),
    });
  expect((await call()).status).toBe(404);
  await db.insert(artifactGrants).values({
    createdAt: now,
    id: "grant",
    kind: "endpoint",
    status: "pending",
    target: "discord",
    versionId: "version",
    workspaceId,
  });
  expect((await call()).status).toBe(404);
  await db.update(artifactGrants).set({ status: "approved" });
  expect((await call()).status).toBe(200);
  await endpoints.change(owner, endpoint.id, "disable");
  expect((await call()).status).toBe(404);
  // A new live version carries the approved endpoint declaration after disable.
  await db.insert(artifactVersions).values({
    artifactId: "artifact",
    authorId: "owner",
    authorKind: "user",
    createdAt: now,
    entry: "index.html",
    fileCount: 1,
    id: "version-2",
    manifestKey: "m2",
    message: "",
    number: 2,
    status: "published",
    totalBytes: 1,
    workspaceId,
  });
  const { ensureEndpointStatement } = await import(
    "@repo/db/artifact-endpoints"
  );
  await sqliteAtomic(db)([
    db.insert(artifactGrants).values({
      createdAt: now,
      id: "grant-2",
      kind: "endpoint",
      status: "approved",
      target: "discord",
      versionId: "version-2",
      workspaceId,
    }),
    ensureEndpointStatement(
      db,
      {
        artifactId: "artifact",
        createdAt: now,
        id: "must-not-reopen",
        name: "discord",
        workspaceId,
      },
      "grant-2"
    ),
    db.update(artifacts).set({ currentVersionId: "version-2" }),
  ]);
  expect(await endpoints.list(owner, "artifact")).toMatchObject([
    { disabledAt: now, id: endpoint.id },
  ]);
  expect(await db.select().from(artifactEndpoints)).toHaveLength(1);
  expect((await call()).status).toBe(404);
  await endpoints.change(owner, endpoint.id, "enable");
  expect((await call()).status).toBe(200);
  const rotated = await endpoints.change(owner, endpoint.id, "rotate");
  expect((await call()).status).toBe(404);
  expect((await call(rotated.id)).status).toBe(200);
  await db.update(artifacts).set({ currentVersionId: null });
  expect((await call(rotated.id)).status).toBe(404);
  expect((await call("unknown")).status).toBe(404);
  await Promise.all(work);
  expect(await db.select().from(artifactViews)).toHaveLength(3);
});

test("limiter rejects every id before resolution or privacy writes", async () => {
  const h = setup();
  h.limit();
  await Promise.all(
    ["unknown", "disabled", "approved", "rotated"].map(async (id) => {
      const response = await h.app.request(`/hooks/${id}`, {
        headers: { "CF-Connecting-IP": "1.2.3.4" },
      });
      expect(response.status).toBe(429);
    })
  );
  expect(h.access).toEqual([]);
  expect(h.logs).toEqual([]);
  expect(h.keys.toSorted()).toEqual(
    Array.from({ length: 4 }, () => [
      "api:endpoints:ip:1.2.3.0/24",
      "api:endpoints:ip:1.2.3.0/24:overflow",
    ])
      .flat()
      .toSorted()
  );
});

test("IP-only budget stops random ids before D1 reads and resets for another prefix", async () => {
  const h = setup();
  for (let index = 0; index < 600; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise sequential limiter consumption
    const response = await h.call(`/hooks/random-${index}`, {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(response.status).toBe(404);
  }
  expect(h.access).toHaveLength(600);
  h.keys.length = 0;
  const response = await h.call("/hooks/another-random-id", {
    headers: { "CF-Connecting-IP": "1.2.3.99" },
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(h.keys).toEqual([
    "api:endpoints:ip:1.2.3.0/24",
    "api:endpoints:ip:1.2.3.0/24:overflow",
  ]);
  expect(h.access).toHaveLength(600);
  expect(h.logs).toEqual([]);
  expect(
    (
      await h.call("/hooks/new-prefix", {
        headers: { "CF-Connecting-IP": "1.2.4.4" },
      })
    ).status
  ).toBe(404);
});

test("per-endpoint budget rejects at 300 before the IP-only budget is exhausted", async () => {
  const h = setup();
  for (let index = 0; index < 300; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise sequential limiter consumption
    expect((await h.call("/hooks/approved")).status).toBe(200);
  }
  expect((await h.call("/hooks/approved")).status).toBe(429);
  expect(h.access).toHaveLength(600);
  h.active.add("other-endpoint");
  expect((await h.call("/hooks/other-endpoint")).status).toBe(200);
  await Promise.all(h.work);
});

test("request waitUntil logs recordCall failure with ids only and preserves the app response", async () => {
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const h = setup(true);
    const response = await h.call("/hooks/approved", {
      body: "private body",
      headers: { authorization: "Bearer secret" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(h.work).toHaveLength(1);
    await Promise.all(h.work);
    expect(error.mock.calls).toEqual([
      [
        "Failed to record endpoint call",
        {
          artifactId: "a",
          endpointId: "approved",
          versionId: "v",
          workspaceId: "w",
        },
      ],
    ]);
  } finally {
    error.mockRestore();
  }
});

test.each([200, 404, 502])(
  "route records status %i, duration and outcome around the handler",
  async (status) => {
    const timer = spyOn(performance, "now").mockReturnValue(137);
    for (let index = 0; index < 9; index += 1) {
      timer.mockReturnValueOnce(100);
    }
    try {
      const h = setup(false, status);
      const response = await h.call("/hooks/approved");
      await Promise.all(h.work);
      expect(response.status).toBe(status);
      expect(h.metrics).toEqual([{ durationMs: 37, statusCode: status }]);
      expect(h.logs).toEqual([status >= 500 ? "error" : "ok"]);
    } finally {
      timer.mockRestore();
    }
  }
);

test("endpoint stage timings contain only the endpoint name and milliseconds", async () => {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const h = setup();
    await h.call("/hooks/approved/private-path?token=secret", {
      headers: { authorization: "Bearer private" },
    });
    expect(
      log.mock.calls.map(([prefix, data]) => [prefix, JSON.parse(String(data))])
    ).toEqual([
      [
        "app endpoint timing",
        {
          appResponse: expect.any(Number),
          endpoint: "discord",
          limiter: expect.any(Number),
          meta: expect.any(Number),
          resolve: expect.any(Number),
          total: expect.any(Number),
        },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});
