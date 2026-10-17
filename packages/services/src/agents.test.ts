import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const NOW = "2026-01-01T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createAgentsService>;
let events: ReturnType<typeof createEventsService>;

const seedWorkspace = (conn: ReturnType<typeof migrated>, id: string) =>
  conn
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const insertMachine = (id: string, workspaceId: string) =>
  db
    .insert(machines)
    .values({
      capabilities: "{}",
      createdAt: NOW,
      credentialHash: `hash-${id}`,
      enrolledBy: "u1",
      id,
      name: "laptop",
      singleUser: false,
      status: "online",
      workspaceId,
    })
    .run();

beforeEach(() => {
  db = migrated();
  seedWorkspace(db, WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  const store = new Map<string, string>();
  events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  service = createAgentsService({ db, events });
});

test("create returns an active record and writes an agent.created event", async () => {
  const agent = await service.create(user, {
    model: "claude-haiku-5-5",
    name: "Digest",
    runtime: "fake",
  });
  expect(agent).toMatchObject({
    createdBy: "u1",
    instructions: "",
    machineId: null,
    model: "claude-haiku-5-5",
    name: "Digest",
    runtime: "fake",
    runtimeConfig: {},
    slug: "digest",
    status: "active",
    workspaceId: WORKSPACE,
  });
  const [event] = await events.query(user, WORKSPACE, {
    agentId: agent.id,
    types: ["agent.created"],
  });
  expect(event).toMatchObject({
    actor: { id: "u1", kind: "user" },
    agentId: agent.id,
    payload: { name: "Digest", runtime: "fake", slug: "digest" },
    workspaceId: WORKSPACE,
  });
});

test("the slug is derived from the name", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "  Daily Digest!!  ",
    runtime: "fake",
  });
  expect(agent.slug).toBe("daily-digest");
  expect(agent.name).toBe("Daily Digest!!");
  await expect(
    service.create(user, { model: "m", name: "!!!", runtime: "fake" })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("a taken slug is a conflict and creates no second row", async () => {
  await service.create(user, { model: "m", name: "Digest", runtime: "fake" });
  await expect(
    service.create(user, {
      model: "m",
      name: "Other",
      runtime: "fake",
      slug: "digest",
    })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(db.select().from(agents).all()).toHaveLength(1);
});

test("bad slugs are rejected", async () => {
  await Promise.all(
    ["A", "-x", "x_y"].map((slug) =>
      expect(
        service.create(user, {
          model: "m",
          name: "Name",
          runtime: "fake",
          slug,
        })
      ).rejects.toThrow()
    )
  );
  expect(db.select().from(agents).all()).toHaveLength(0);
});

test("runtime fake is accepted and refuses a machineId", async () => {
  await expect(
    service.create(user, {
      machineId: "m1",
      model: "m",
      name: "Fake",
      runtime: "fake",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  const agent = await service.create(user, {
    machineId: null,
    model: "m",
    name: "Fake",
    runtime: "fake",
  });
  expect(agent.machineId).toBeNull();
});

test("runtime machine needs a machine row of the same workspace", async () => {
  await expect(
    service.create(user, { model: "m", name: "Box", runtime: "machine" })
  ).rejects.toMatchObject({ code: "invalid" });

  insertMachine("m-other", OTHER_WORKSPACE);
  await expect(
    service.create(user, {
      machineId: "m-other",
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).rejects.toMatchObject({ code: "invalid" });

  insertMachine("m-mine", WORKSPACE);
  const agent = await service.create(user, {
    machineId: "m-mine",
    model: "m",
    name: "Box",
    runtime: "machine",
  });
  expect(agent.machineId).toBe("m-mine");
});

test("get of an agent in another workspace is not_found", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "Mine",
    runtime: "fake",
  });
  await expect(service.get(otherUser, agent.id)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await service.get(user, agent.id)).id).toBe(agent.id);
});

test("list hides archived agents unless asked", async () => {
  await service.create(user, { model: "m", name: "Beta", runtime: "fake" });
  const alpha = await service.create(user, {
    model: "m",
    name: "Alpha",
    runtime: "fake",
  });
  await service.archive(user, alpha.id);

  expect((await service.list(user)).map((a) => a.name)).toEqual(["Beta"]);
  expect(
    (await service.list(user, { includeArchived: true })).map((a) => a.name)
  ).toEqual(["Alpha", "Beta"]);
});

test("update changes fields and rejects an empty patch", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "Old",
    runtime: "fake",
  });
  const updated = await service.update(user, agent.id, {
    instructions: "Be brief.",
    name: "New name",
    runtimeConfig: { retries: 2 },
  });
  expect(updated).toMatchObject({
    instructions: "Be brief.",
    name: "New name",
    runtimeConfig: { retries: 2 },
    slug: "old",
  });
  const [event] = await events.query(user, WORKSPACE, {
    types: ["agent.updated"],
  });
  expect(event?.payload).toEqual({
    changed: ["instructions", "name", "runtimeConfig"],
  });

  await expect(service.update(user, agent.id, {})).rejects.toThrow();
});

test("create and update keep the cloud environment and refuse an unknown one", async () => {
  const agent = await service.create(user, {
    model: "sonnet",
    name: "Vm agent",
    runtime: "cloud",
    runtimeConfig: { environment: "linux-vm" },
  });
  expect(agent.runtimeConfig).toEqual({ environment: "linux-vm" });
  const updated = await service.update(user, agent.id, {
    runtimeConfig: { environment: "isolate" },
  });
  expect(updated.runtimeConfig).toEqual({ environment: "isolate" });

  await expect(
    service.create(user, {
      model: "sonnet",
      name: "Bad env",
      runtime: "cloud",
      runtimeConfig: { environment: "mainframe" },
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.update(user, agent.id, { runtimeConfig: { environment: 3 } })
  ).rejects.toMatchObject({ code: "invalid" });

  // Only a cloud agent has an environment.
  await expect(
    service.create(user, {
      model: "m",
      name: "Fake env",
      runtime: "fake",
      runtimeConfig: { environment: "linux-vm" },
    })
  ).rejects.toMatchObject({ code: "invalid" });
  const fake = await service.create(user, {
    model: "m",
    name: "Fake plain",
    runtime: "fake",
  });
  await expect(
    service.update(user, fake.id, {
      runtimeConfig: { environment: "isolate" },
    })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("archive is idempotent and writes one event", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "Once",
    runtime: "fake",
  });
  expect((await service.archive(user, agent.id)).status).toBe("archived");
  expect((await service.archive(user, agent.id)).status).toBe("archived");
  const archived = await events.query(user, WORKSPACE, {
    types: ["agent.updated"],
  });
  expect(archived).toHaveLength(1);
  expect(archived[0]?.payload).toEqual({ status: "archived" });
});

test("a run principal cannot create an agent", async () => {
  const run: Principal = {
    agentId: "a1",
    kind: "run",
    runId: "r1",
    workspaceId: WORKSPACE,
  };
  await expect(
    service.create(run, { model: "m", name: "Nope", runtime: "fake" })
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(db.select().from(agents).all()).toHaveLength(0);
});
