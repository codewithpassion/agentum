import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { mountEndpointRoutes } from "./endpoints.ts";
import { fakePorts } from "./fakes.ts";
import type { AppRuntimeInput } from "./ports.ts";

const setup = () => {
  const active = new Set(["approved"]);
  const seen: AppRuntimeInput[] = [];
  const keys: string[] = [];
  const logs: string[] = [];
  let limited = false;
  const app = new Hono<AppEnv>();
  mountEndpointRoutes(app, {
    limiter: () => ({
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: !limited });
      },
    }),
    wiring: () => ({
      declaresHosts: () => Promise.resolve(true),
      endpoints: {
        recordCall: (_id, _meta, outcome) => {
          logs.push(outcome);
          return Promise.resolve();
        },
        resolve: (id) =>
          Promise.resolve(
            active.has(id)
              ? {
                  artifactId: "a",
                  endpointId: id,
                  versionId: "v",
                  workspaceId: "w",
                }
              : null
          ),
        workspaceIdOf: () => Promise.resolve(null),
      },
      ports: fakePorts(),
      requestMeta: () =>
        Promise.resolve({
          ipPrefix: null,
          place: null,
          userAgent: null,
          visitorHash: "h",
        }),
      runtime: {
        handle: (input) => {
          seen.push(input);
          return Promise.resolve(
            new Response(input.request.body, {
              headers: {
                "content-type": "application/octet-stream",
                "set-cookie": "evil",
              },
            })
          );
        },
      },
    }),
  });
  return {
    active,
    app,
    keys,
    limit: () => {
      limited = true;
    },
    logs,
    seen,
  };
};

test("unknown, disabled, missing and pending grant ids have the same fixed 404", async () => {
  const { app, seen } = setup();
  await Promise.all(
    ["unknown", "disabled", "missing-grant", "pending"].map(async (id) => {
      const response = await app.request(`/hooks/${id}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found.");
    })
  );
  expect(seen).toHaveLength(0);
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
  expect(h.keys).toContain("api:endpoint:rotated");
  expect(h.keys.some((key) => key.startsWith("api:endpoint:rotated:ip:"))).toBe(
    true
  );
  expect(h.logs.at(-1)).toBe("rate_limited");
});

test("HTTP ingress rechecks database grants and live versions; disable, enable and rotate apply immediately", async () => {
  const { migrated } = await import("@repo/db/test-db");
  const { sqliteAtomic } = await import("@repo/db/atomic");
  const { artifactGrants, artifacts, artifactVersions, artifactViews } =
    await import("@repo/db/schema/artifacts");
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
  });
  await endpoints.ensure("artifact", workspaceId, "discord");
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
  const call = (id = endpoint.id) => app.request(`/hooks/${id}`);
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
  await endpoints.change(owner, endpoint.id, "enable");
  expect((await call()).status).toBe(200);
  const rotated = await endpoints.change(owner, endpoint.id, "rotate");
  expect((await call()).status).toBe(404);
  expect((await call(rotated.id)).status).toBe(200);
  await db.update(artifacts).set({ currentVersionId: null });
  expect((await call(rotated.id)).status).toBe(404);
  expect((await call("unknown")).status).toBe(404);
  expect(await db.select().from(artifactViews)).toHaveLength(8);
});
