import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { connectors, credentials } from "@repo/db/schema/connectors";
import { CONNECTOR_CALL_TIMEOUT_SECONDS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "../authz.ts";
import { createCatalogService } from "../catalog.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { entries } from "./entries.ts";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const START = "2026-11-20T00:00:00.000Z";
const clock: Clock = {
  now: () => new Date(START),
  sleep: () => Promise.resolve(),
};
const admin: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "user_admin",
  via: "session",
  workspaceId: "ws_org_a",
};
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createCatalogService>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  db = migrated(["org_a", "org_b"]);
  service = createCatalogService({ clock, db });
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("catalogue must never fetch")
  );
});

afterEach(() => {
  // biome-ignore lint/suspicious/noMisplacedAssertion: every add test must prove it made no network calls
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  db.client.close();
});

// Exercise every real entry so both authenticated and public apps are covered.
test.each(entries)(
  "add creates $key directly from its entry",
  async (entry) => {
    const { connectorId } = await service.add(admin, entry.key);
    expect(connectorId).toMatch(ULID_PATTERN);
    expect(db.select().from(connectors).all()).toEqual([
      {
        authKind: entry.authKind,
        authMode: entry.authKind,
        callTimeoutSeconds: CONNECTOR_CALL_TIMEOUT_SECONDS.default,
        catalogKey: entry.key,
        createdAt: START,
        createdBy: admin.userId,
        headerName: entry.authKind === "header" ? "Authorization" : null,
        headerTemplate: null,
        id: connectorId,
        name: entry.name,
        oauth: null,
        secretId: null,
        status: entry.authKind === "none" ? "ok" : "needs_auth",
        tools: "[]",
        toolsFetchedAt: null,
        url: entry.url,
        workspaceId: admin.workspaceId,
      },
    ]);
    expect(db.select().from(credentials).all()).toEqual([]);
  }
);

test("add is idempotent within its workspace", async () => {
  const first = await service.add(admin, "gmail");
  expect(await service.add(admin, "gmail")).toEqual(first);
  expect(db.select().from(connectors).all()).toHaveLength(1);
});

test("the same key in another workspace creates its own connector", async () => {
  const first = await service.add(admin, "gmail");
  const second = await service.add(
    { ...admin, workspaceId: "ws_org_b" },
    "gmail"
  );
  expect(second.connectorId).not.toBe(first.connectorId);
  expect(db.select().from(connectors).all()).toHaveLength(2);
});

test("add requires an admin browser session even for an existing app", async () => {
  await service.add(admin, "gmail");
  for (const principal of [
    { ...admin, isAdmin: false },
    { ...admin, apiKey: { access: "admin", id: "key" }, via: "api_key" },
    { kind: "system" },
  ] satisfies Principal[]) {
    // biome-ignore lint/performance/noAwaitInLoops: independently check each refused principal
    await expect(service.add(principal, "gmail")).rejects.toBeInstanceOf(
      ForbiddenError
    );
  }
  expect(db.select().from(connectors).all()).toHaveLength(1);
});

test("an unknown key is not_found", async () => {
  const result = service.add(admin, "unknown");
  await expect(result).rejects.toBeInstanceOf(ServiceError);
  await expect(result).rejects.toMatchObject({ code: "not_found" });
  expect(db.select().from(connectors).all()).toHaveLength(0);
});

test("list returns all entries in catalogue order with default allow-lists", () => {
  expect(service.list()).toEqual([...entries]);
  expect(service.list().length).toBeGreaterThan(0);
  for (const entry of service.list()) {
    expect(entry.defaultAllowedTools.length).toBeGreaterThan(0);
  }
});
