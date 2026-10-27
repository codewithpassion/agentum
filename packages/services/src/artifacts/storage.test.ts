import { describe, expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import {
  type AppStorePort,
  type AppStoreScope,
  createArtifactStorageService,
} from "./storage.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const fakeStore = () => {
  const data = new Map<string, string>();
  let failWith: Error | null = null;
  const id = (scope: AppStoreScope, key: string) =>
    `${scope.area}/${scope.artifactId}/${scope.area === "viewer" ? scope.viewerKey : "-"}/${key}`;
  const prefixOf = (scope: AppStoreScope) => `${id(scope, "").slice(0, -1)}/`;
  const store: AppStorePort = {
    delete: (scope, key) => {
      data.delete(id(scope, key));
      return Promise.resolve();
    },
    get: (scope, key) => Promise.resolve(data.get(id(scope, key)) ?? null),
    list: (scope, prefix, limit) => {
      const base = prefixOf(scope);
      const items = [...data.entries()]
        .filter(([k]) => k.startsWith(base))
        .map(([k, value]) => ({ key: k.slice(base.length), value }))
        .filter((item) => item.key.startsWith(prefix))
        .slice(0, limit);
      return Promise.resolve(items);
    },
    set: (scope, key, value) => {
      if (failWith) {
        return Promise.reject(failWith);
      }
      data.set(id(scope, key), value);
      return Promise.resolve();
    },
  };
  return {
    data,
    fail: (error: Error) => {
      failWith = error;
    },
    store,
  };
};

const seed = () => {
  const db = migrated();
  for (const id of ["w1", "w2"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  const artifact = (
    id: string,
    workspaceId: string,
    audience: "private" | "workspace",
    ownerUserId: string
  ) =>
    db
      .insert(artifacts)
      .values({
        audience,
        createdAt: NOW,
        createdById: ownerUserId,
        createdByKind: "user",
        id,
        kind: "app",
        ownerUserId,
        title: id,
        updatedAt: NOW,
        workspaceId,
      })
      .run();
  artifact("shared-app", "w1", "workspace", "alice");
  artifact("alice-private", "w1", "private", "alice");
  artifact("other-ws", "w2", "workspace", "zed");
  return db;
};

const user = (userId: string, isAdmin = false): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId: "w1",
});

const setup = () => {
  const fake = fakeStore();
  const service = createArtifactStorageService({
    db: seed(),
    store: fake.store,
  });
  return { ...fake, service };
};

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  return error;
};
const NOT_FOUND = { code: "not_found" };

describe("round trip", () => {
  for (const scope of ["viewer", "shared"] as const) {
    test(`set, get, list and delete in the ${scope} area`, async () => {
      const { service } = setup();
      const bob = user("bob");
      const base = { artifactId: "shared-app", scope };
      await service.set(bob, {
        ...base,
        key: "todo:1",
        value: { done: false },
      });
      await service.set(bob, { ...base, key: "todo:2", value: [1, 2] });
      await service.set(bob, { ...base, key: "note", value: "hi" });
      expect(await service.get(bob, { ...base, key: "todo:1" })).toEqual({
        value: { done: false },
      });
      expect(await service.get(bob, { ...base, key: "gone" })).toEqual({
        value: null,
      });
      expect(
        (await service.list(bob, { ...base, prefix: "todo:" })).keys
      ).toEqual(["todo:1", "todo:2"]);
      expect((await service.list(bob, base)).keys).toHaveLength(3);
      await service.delete(bob, { ...base, key: "todo:1" });
      expect(await service.get(bob, { ...base, key: "todo:1" })).toEqual({
        value: null,
      });
    });
  }

  test("a stored JSON null reads back as null, not the text", async () => {
    const { service } = setup();
    const bob = user("bob");
    const base = {
      artifactId: "shared-app",
      key: "n",
      scope: "shared",
    } as const;
    await service.set(bob, { ...base, value: null });
    expect(await service.get(bob, base)).toEqual({ value: null });
  });
});

describe("areas", () => {
  test("members do not see each other's viewer area but share the shared area", async () => {
    const { service } = setup();
    const bob = user("bob");
    const carol = user("carol");
    const viewer = {
      artifactId: "shared-app",
      key: "k",
      scope: "viewer",
    } as const;
    const shared = { ...viewer, scope: "shared" } as const;
    await service.set(bob, { ...viewer, value: "bob" });
    await service.set(bob, { ...shared, value: "common" });
    expect(await service.get(carol, viewer)).toEqual({ value: null });
    expect(await service.get(bob, viewer)).toEqual({ value: "bob" });
    expect(await service.get(carol, shared)).toEqual({ value: "common" });
  });
});

describe("access", () => {
  const input = {
    artifactId: "alice-private",
    key: "k",
    scope: "shared",
  } as const;

  test("someone else's private artifact is not_found for a member", async () => {
    const { service } = setup();
    expect(await rejection(service.get(user("bob"), input))).toMatchObject(
      NOT_FOUND
    );
    expect(
      await rejection(service.set(user("bob"), { ...input, value: 1 }))
    ).toMatchObject(NOT_FOUND);
    expect(await rejection(service.delete(user("bob"), input))).toMatchObject(
      NOT_FOUND
    );
    expect(
      await rejection(
        service.list(user("bob"), {
          artifactId: "alice-private",
          scope: "shared",
        })
      )
    ).toMatchObject(NOT_FOUND);
  });

  test("an admin and the owner can use it", async () => {
    const { service } = setup();
    await service.set(user("alice"), { ...input, value: 1 });
    expect(await service.get(user("root", true), input)).toEqual({ value: 1 });
  });

  test("a missing artifact and another workspace's artifact are not_found", async () => {
    const { service } = setup();
    expect(
      await rejection(
        service.get(user("bob"), { ...input, artifactId: "nope" })
      )
    ).toMatchObject(NOT_FOUND);
    expect(
      await rejection(
        service.get(user("root", true), { ...input, artifactId: "other-ws" })
      )
    ).toMatchObject(NOT_FOUND);
  });

  test("a non-user principal is refused", async () => {
    const { service } = setup();
    const run: Principal = {
      agentId: "a",
      kind: "run",
      runId: "r",
      workspaceId: "w1",
    };
    const outcome = service.get(run, { ...input, artifactId: "shared-app" });
    await expect(outcome).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("limits", () => {
  const base = { artifactId: "shared-app", scope: "viewer" } as const;

  test("a key over 256 bytes is refused, counted in UTF-8", async () => {
    const { service } = setup();
    const bob = user("bob");
    await service.set(bob, { ...base, key: "a".repeat(256), value: 1 });
    await expect(
      service.set(bob, { ...base, key: "a".repeat(257), value: 1 })
    ).rejects.toMatchObject({ code: "invalid" });
    // 129 two-byte characters is 258 bytes but only 129 characters.
    await expect(
      service.set(bob, { ...base, key: "é".repeat(129), value: 1 })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("a serialized value over 1 MB is refused", async () => {
    const { service } = setup();
    const bob = user("bob");
    // The two quotes of the JSON string count toward the limit.
    await service.set(bob, {
      ...base,
      key: "ok",
      value: "x".repeat(1_048_574),
    });
    await expect(
      service.set(bob, { ...base, key: "big", value: "x".repeat(1_048_575) })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("port quota and size errors map to invalid", async () => {
    const { fail, service } = setup();
    const bob = user("bob");
    fail(new Error("quota_exceeded: 10 MB"));
    const full = service.set(bob, { ...base, key: "k", value: 1 });
    await expect(full).rejects.toMatchObject({
      code: "invalid",
      message: "App storage is full.",
    });
    fail(new Error("too_large"));
    const large = service.set(bob, { ...base, key: "k", value: 1 });
    await expect(large).rejects.toMatchObject({
      code: "invalid",
      message: "That value is too large.",
    });
    fail(new Error("boom"));
    const other = service.set(bob, { ...base, key: "k", value: 1 });
    await expect(other).rejects.toThrow("boom");
    await other.catch((error: unknown) => {
      expect(isServiceError(error)).toBe(false);
    });
  });
});

describe("plain text", () => {
  test("a stored string that is not JSON comes back raw", async () => {
    const { data, service } = setup();
    data.set("shared/shared-app/-/log", "hello world");
    expect(
      await service.get(user("bob"), {
        artifactId: "shared-app",
        key: "log",
        scope: "shared",
      })
    ).toEqual({ value: "hello world" });
  });
});
