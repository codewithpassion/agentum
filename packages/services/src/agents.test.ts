import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService, findAgent, handsToNames } from "./agents.ts";
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

test("create and update keep the network setting and refuse a bad one", async () => {
  const agent = await service.create(user, {
    model: "sonnet",
    name: "Offline agent",
    runtime: "cloud",
    runtimeConfig: { networkAccess: false },
  });
  expect(agent.runtimeConfig).toEqual({ networkAccess: false });
  const [stored] = db.select().from(agents).all();
  expect(stored?.runtimeConfig).toBe('{"networkAccess":false}');
  const updated = await service.update(user, agent.id, {
    runtimeConfig: { networkAccess: true },
  });
  expect(updated.runtimeConfig).toEqual({ networkAccess: true });

  await expect(
    service.create(user, {
      model: "sonnet",
      name: "Stringy",
      runtime: "cloud",
      runtimeConfig: { networkAccess: "no" },
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.update(user, agent.id, { runtimeConfig: { networkAccess: 0 } })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("a machine agent refuses the network setting", async () => {
  insertMachine("m-mine", WORKSPACE);
  await expect(
    service.create(user, {
      machineId: "m-mine",
      model: "sonnet",
      name: "Box",
      runtime: "machine",
      runtimeConfig: { networkAccess: false },
    })
  ).rejects.toMatchObject({ code: "invalid" });
  const box = await service.create(user, {
    machineId: "m-mine",
    model: "sonnet",
    name: "Box",
    runtime: "machine",
  });
  await expect(
    service.update(user, box.id, { runtimeConfig: { networkAccess: true } })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("create and update keep legacy library paths without validation", async () => {
  const agent = await service.create(user, {
    model: "sonnet",
    name: "Synced agent",
    runtime: "cloud",
    runtimeConfig: {
      environment: "linux-vm",
      libraryPaths: ["projects/alpha"],
    },
  });
  expect(agent.runtimeConfig).toEqual({
    environment: "linux-vm",
    libraryPaths: ["projects/alpha"],
  });
  const updated = await service.update(user, agent.id, {
    runtimeConfig: { libraryPaths: ["notes/"] },
  });
  expect(updated.runtimeConfig).toEqual({ libraryPaths: ["notes/"] });

  const legacy = await service.update(user, agent.id, { runtimeConfig: { libraryPaths: "ignored" } });
  expect(legacy.runtimeConfig.libraryPaths).toBe("ignored");

  // The key is allowed for every runtime, not only the cloud.
  const fake = await service.create(user, {
    model: "m",
    name: "Fake synced",
    runtime: "fake",
    runtimeConfig: { libraryPaths: ["notes"] },
  });
  expect(fake.runtimeConfig).toEqual({ libraryPaths: ["notes"] });
});

test("create and update keep the turn limit and refuse a bad one", async () => {
  insertMachine("m-mine", WORKSPACE);
  const cloud = await service.create(user, {
    model: "sonnet",
    name: "Cloud turns",
    runtime: "cloud",
    runtimeConfig: { maxTurns: 50 },
  });
  expect(cloud.runtimeConfig).toEqual({ maxTurns: 50 });
  const machine = await service.create(user, {
    machineId: "m-mine",
    model: "sonnet",
    name: "Machine turns",
    runtime: "machine",
    runtimeConfig: { maxTurns: 50 },
  });
  expect(machine.runtimeConfig).toEqual({ maxTurns: 50 });

  const updated = await service.update(user, cloud.id, {
    runtimeConfig: { maxTurns: 200 },
  });
  expect(updated.runtimeConfig).toEqual({ maxTurns: 200 });

  await Promise.all(
    [9, 501, 12.5, "50"].map((maxTurns) =>
      Promise.all([
        expect(
          service.create(user, {
            model: "sonnet",
            name: `Bad turns ${String(maxTurns)}`,
            runtime: "cloud",
            runtimeConfig: { maxTurns },
          })
        ).rejects.toMatchObject({
          code: "invalid",
          message: expect.stringContaining("maxTurns"),
        }),
        expect(
          service.update(user, cloud.id, { runtimeConfig: { maxTurns } })
        ).rejects.toMatchObject({
          code: "invalid",
          message: expect.stringContaining("maxTurns"),
        }),
      ])
    )
  );
  expect((await service.get(user, cloud.id)).runtimeConfig).toEqual({
    maxTurns: 200,
  });
});

test("a managed agent refuses a turn limit", async () => {
  await expect(
    service.create(user, {
      model: "sonnet",
      name: "Managed turns",
      runtime: "managed",
      runtimeConfig: { maxTurns: 50 },
    })
  ).rejects.toMatchObject({
    code: "invalid",
    message: "A managed agent has no turn limit",
  });
  expect(db.select().from(agents).all()).toHaveLength(0);
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

test("a model for another provider is refused on managed and machine agents", async () => {
  insertMachine("m-mine", WORKSPACE);
  await Promise.all(
    [
      { machineId: "m-mine", runtime: "machine" as const },
      { runtime: "managed" as const },
    ].map((base) =>
      expect(
        service.create(user, {
          ...base,
          model: "openrouter:z-ai/glm-5.3",
          name: `Other ${base.runtime}`,
        })
      ).rejects.toThrow("Anthropic models only")
    )
  );
  await expect(
    service.create(user, {
      model: "OpenRouter:z-ai/glm-5.3",
      name: "Upper",
      runtime: "managed",
    })
  ).rejects.toThrow("Anthropic models only");
  expect(db.select().from(agents).all()).toHaveLength(0);
});

test("a cloud agent keeps a model for another provider", async () => {
  const agent = await service.create(user, {
    model: "openrouter:z-ai/glm-5.3",
    name: "Open",
    runtime: "cloud",
  });
  expect(agent.model).toBe("openrouter:z-ai/glm-5.3");
});

test("bare model ids stay valid on managed and machine agents", async () => {
  insertMachine("m-mine", WORKSPACE);
  const models = ["sonnet", "claude-opus-5-5", "us.anthropic.claude-x-v1:0"];
  const created = await Promise.all(
    models.flatMap((model) => [
      service.create(user, {
        model,
        name: `Managed ${model}`,
        runtime: "managed",
      }),
      service.create(user, {
        machineId: "m-mine",
        model,
        name: `Machine ${model}`,
        runtime: "machine",
      }),
    ])
  );
  expect(created.map((agent) => agent.model)).toEqual(
    models.flatMap((model) => [model, model])
  );
});

test("update changes a model only when the runtime allows it", async () => {
  const cloud = await service.create(user, {
    model: "sonnet",
    name: "Cloud",
    runtime: "cloud",
  });
  const switched = await service.update(user, cloud.id, {
    model: "openrouter:z-ai/glm-5.3",
  });
  expect(switched.model).toBe("openrouter:z-ai/glm-5.3");

  const managed = await service.create(user, {
    model: "sonnet",
    name: "Managed",
    runtime: "managed",
  });
  await expect(
    service.update(user, managed.id, { model: "openrouter:z-ai/glm-5.3" })
  ).rejects.toThrow("Anthropic models only");
  expect((await service.get(user, managed.id)).model).toBe("sonnet");

  const renamed = await service.update(user, managed.id, { name: "Renamed" });
  expect(renamed).toMatchObject({ model: "sonnet", name: "Renamed" });
});

test("a created agent has no soul, no hand-offs and no email address", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "Plain",
    runtime: "fake",
  });
  expect(agent).toMatchObject({ emailLocal: null, handsTo: [], soul: "" });
});

test("drafts are missing from list, with or without archived, and findAgent returns them", async () => {
  await service.create(user, { model: "m", name: "Live", runtime: "fake" });
  db.insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      emailLocal: null,
      handsTo: "[]",
      id: "draft-1",
      instructions: "",
      machineId: null,
      model: "m",
      name: "Drafted",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "drafted",
      soul: "",
      status: "draft",
      workspaceId: WORKSPACE,
    })
    .run();

  expect((await service.list(user)).map((a) => a.name)).toEqual(["Live"]);
  expect(
    (await service.list(user, { includeArchived: true })).map((a) => a.name)
  ).toEqual(["Live"]);
  expect(await findAgent(db, { id: "draft-1" })).toMatchObject({
    name: "Drafted",
    status: "draft",
  });
});

test("a row with soul, hands-to and an email address maps to the record fields", async () => {
  db.insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      emailLocal: "digest",
      handsTo: '["a"]',
      id: "profiled-1",
      instructions: "",
      machineId: null,
      model: "m",
      name: "Profiled",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "profiled",
      soul: "Warm and brief.",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();

  expect(await service.get(user, "profiled-1")).toMatchObject({
    emailLocal: "digest",
    handsTo: ["a"],
    soul: "Warm and brief.",
  });
});

const createFake = (name: string, principal = user) =>
  service.create(principal, { model: "m", name, runtime: "fake" });

test("voice and hands to persist, clear, and only field names enter updated events", async () => {
  const target = await createFake("Target");
  const agent = await service.create(user, {
    handsTo: [target.id],
    model: "m",
    name: "Speaker",
    runtime: "fake",
    soul: "Private voice",
  });
  expect(await service.get(user, agent.id)).toMatchObject({
    handsTo: [target.id],
    soul: "Private voice",
  });
  await service.update(user, agent.id, {
    handsTo: [],
    soul: "Another private voice",
  });
  expect(await service.get(user, agent.id)).toMatchObject({
    handsTo: [],
    soul: "Another private voice",
  });
  const [event] = await events.query(user, WORKSPACE, {
    agentId: agent.id,
    types: ["agent.updated"],
  });
  expect(event?.payload).toEqual({ changed: ["handsTo", "soul"] });
  expect(JSON.stringify(event)).not.toContain("private voice");
  expect((await service.update(user, agent.id, { soul: "" })).soul).toBe("");
});

test("voice is limited to 10000 characters on create and update", async () => {
  const agent = await service.create(user, {
    model: "m",
    name: "Long voice",
    runtime: "fake",
    soul: "x".repeat(10_000),
  });
  expect(agent.soul).toHaveLength(10_000);
  await expect(
    service.update(user, agent.id, { soul: "x".repeat(10_001) })
  ).rejects.toThrow();
  await expect(
    service.create(user, {
      model: "m",
      name: "Too long",
      runtime: "fake",
      soul: "x".repeat(10_001),
    })
  ).rejects.toThrow();
});

test("hands to rejects self, foreign, archived, draft and missing agents", async () => {
  const agent = await createFake("Source");
  const foreign = await createFake("Foreign", otherUser);
  const archived = await createFake("Archived");
  await service.archive(user, archived.id);
  const draft = await createFake("Draft");
  db.update(agents)
    .set({ status: "draft" })
    .where(eq(agents.id, draft.id))
    .run();
  await expect(
    service.update(user, agent.id, { handsTo: [agent.id] })
  ).rejects.toMatchObject({ code: "invalid" });
  await Promise.all(
    [foreign.id, archived.id, draft.id, "missing"].map(async (id) => {
      await expect(
        service.create(user, {
          handsTo: [id],
          model: "m",
          name: "Invalid",
          runtime: "fake",
        })
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        service.update(user, agent.id, { handsTo: [id] })
      ).rejects.toMatchObject({ code: "invalid" });
    })
  );
  expect((await service.get(user, agent.id)).handsTo).toEqual([]);
});

test("hands to names preserve configured order and drop archived or foreign targets", async () => {
  const alpha = await createFake("Alpha");
  const beta = await createFake("Beta");
  const foreign = await createFake("Foreign", otherUser);
  const source = await service.create(user, {
    handsTo: [beta.id, alpha.id],
    model: "m",
    name: "Source",
    runtime: "fake",
  });
  expect(await handsToNames(db, source)).toEqual(["Beta", "Alpha"]);
  await service.archive(user, beta.id);
  expect(
    await handsToNames(db, {
      ...source,
      handsTo: [...source.handsTo, foreign.id, "missing"],
    })
  ).toEqual(["Alpha"]);
  expect(await handsToNames(db, { ...source, handsTo: [] })).toEqual([]);
});

test("address suggestions and checks see reservations in every workspace, including archived agents", async () => {
  const owner = await createFake("Owner", otherUser);
  expect(await service.suggestAddress("digest")).toBe("digest");
  expect(await service.checkAddress(user, "digest")).toEqual({
    available: true,
  });
  await service.reserveAddress(otherUser, owner.id, "digest");
  await service.archive(otherUser, owner.id);
  expect(await service.checkAddress(user, "digest")).toEqual({
    available: false,
  });
  expect(await service.suggestAddress("digest")).toBe("digest-2");
  const second = await createFake("Second");
  await service.reserveAddress(user, second.id, "digest-2");
  expect(await service.suggestAddress("digest")).toBe("digest-3");
  expect(Object.keys(await service.checkAddress(user, "digest"))).toEqual([
    "available",
  ]);
});

test("address syntax and reserved words are refused by checks and reservations", async () => {
  const agent = await createFake("Address");
  await Promise.all(
    [
      "a",
      "a".repeat(41),
      "Upper",
      "with_space",
      "a@b",
      "ab\n",
      "postmaster",
      "abuse",
      "admin",
      "noreply",
    ].map(async (local) => {
      await expect(service.checkAddress(user, local)).rejects.toMatchObject({
        code: "invalid",
      });
      await expect(
        service.reserveAddress(user, agent.id, local)
      ).rejects.toMatchObject({ code: "invalid" });
    })
  );
  await Promise.all(
    ["ab", "a.b-c9", "a".repeat(40)].map(async (local) => {
      expect(await service.checkAddress(user, local)).toEqual({
        available: true,
      });
    })
  );
  expect(await service.suggestAddress("admin")).toBe("admin-2");
  expect((await service.get(user, agent.id)).emailLocal).toBeNull();
});

test("reservation writes the address and event; a second reservation conflicts without an event", async () => {
  const first = await service.createDraft(user, { name: "First" });
  const second = await createFake("Second", otherUser);
  expect(
    await service.reserveAddress(user, first.id, "reserved")
  ).toMatchObject({ emailLocal: "reserved" });
  await expect(
    service.reserveAddress(otherUser, second.id, "reserved")
  ).rejects.toMatchObject({
    code: "conflict",
    message: "That address is taken",
  });
  expect(
    await events.query(user, WORKSPACE, {
      agentId: first.id,
      types: ["agent.address_reserved"],
    })
  ).toHaveLength(1);
  expect(
    await events.query(otherUser, OTHER_WORKSPACE, {
      agentId: second.id,
      types: ["agent.address_reserved"],
    })
  ).toHaveLength(0);
  await expect(
    service.reserveAddress(otherUser, first.id, "other")
  ).rejects.toMatchObject({ code: "not_found" });
});

test("drafts use cloud defaults, remain readable, and choose slugs including discarded drafts", async () => {
  const first = await service.createDraft(user, {
    name: "Builder",
    runtimeConfig: { environment: "isolate", networkAccess: false },
  });
  expect(first).toMatchObject({
    model: "claude-sonnet-5-5",
    runtime: "cloud",
    runtimeConfig: { environment: "isolate", networkAccess: false },
    status: "draft",
  });
  expect(await service.get(user, first.id)).toEqual(first);
  expect(await service.list(user)).toEqual([]);
  expect(await service.list(user, { includeArchived: true })).toEqual([]);
  expect(
    await events.query(user, WORKSPACE, { types: ["agent.created"] })
  ).toHaveLength(0);
  expect((await service.discardDraft(user, first.id)).status).toBe("archived");
  expect((await service.discardDraft(user, first.id)).status).toBe("archived");
  expect((await service.createDraft(user, { name: "Builder" })).slug).toBe(
    "builder-2"
  );
  expect((await service.createDraft(otherUser, { name: "Builder" })).slug).toBe(
    "builder"
  );
  const long = "a".repeat(40);
  await service.createDraft(user, { name: long });
  expect((await service.createDraft(user, { name: long })).slug).toBe(
    `${"a".repeat(38)}-2`
  );
});

test("activation validates the chosen runtime and retains the draft identity and address", async () => {
  const draft = await service.createDraft(user, {
    name: "Builder",
    soul: "Brief",
  });
  await service.reserveAddress(user, draft.id, "builder");
  await Promise.all(
    [
      { model: "sonnet", runtime: "machine" as const },
      { machineId: "missing", model: "sonnet", runtime: "machine" as const },
      { model: "openrouter:other", runtime: "managed" as const },
      {
        model: "m",
        runtime: "fake" as const,
        runtimeConfig: { networkAccess: false },
      },
      { machineId: "missing", model: "sonnet", runtime: "cloud" as const },
    ].map(async (config) => {
      await expect(
        service.activate(user, draft.id, config)
      ).rejects.toMatchObject({ code: "invalid" });
    })
  );
  await expect(
    service.activate(otherUser, draft.id, { model: "m", runtime: "fake" })
  ).rejects.toMatchObject({ code: "not_found" });
  insertMachine("chosen", WORKSPACE);
  expect(
    await service.activate(user, draft.id, {
      machineId: "chosen",
      model: "sonnet",
      runtime: "machine",
      runtimeConfig: { maxTurns: 20 },
    })
  ).toMatchObject({
    emailLocal: "builder",
    id: draft.id,
    machineId: "chosen",
    model: "sonnet",
    runtime: "machine",
    runtimeConfig: { maxTurns: 20 },
    soul: "Brief",
    status: "active",
  });
  expect(await service.list(user)).toHaveLength(1);
  expect(
    await events.query(user, WORKSPACE, {
      agentId: draft.id,
      types: ["agent.created"],
    })
  ).toHaveLength(1);
  await expect(service.discardDraft(user, draft.id)).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(
    service.activate(user, draft.id, { model: "m", runtime: "fake" })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("concurrent drafts choose distinct slugs and address reservations have one winner", async () => {
  const drafts = await Promise.all([
    service.createDraft(user, { name: "Concurrent" }),
    service.createDraft(user, { name: "Concurrent" }),
  ]);
  expect(drafts.map((draft) => draft.slug).sort()).toEqual([
    "concurrent",
    "concurrent-2",
  ]);
  const outcomes = await Promise.allSettled(
    drafts.map((draft) => service.reserveAddress(user, draft.id, "concurrent"))
  );
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled")
  ).toHaveLength(1);
  expect(
    outcomes.find((outcome) => outcome.status === "rejected")
  ).toMatchObject({
    reason: { code: "conflict", message: "That address is taken" },
  });
});

test("only users create drafts, reserve addresses and change draft lifecycle", async () => {
  const draft = await service.createDraft(user, { name: "Guarded" });
  const run: Principal = {
    agentId: draft.id,
    kind: "run",
    runId: "r1",
    workspaceId: WORKSPACE,
  };
  await expect(
    service.createDraft(run, { name: "Nope" })
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    service.reserveAddress(run, draft.id, "nope")
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    service.activate(run, draft.id, { model: "m", runtime: "fake" })
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.discardDraft(run, draft.id)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(service.discardDraft(otherUser, draft.id)).rejects.toMatchObject(
    { code: "not_found" }
  );
});
