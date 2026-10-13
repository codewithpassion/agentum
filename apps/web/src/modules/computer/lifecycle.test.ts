import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";
import type {
  CreateMachineInput,
  CreateVolumeInput,
  FlyGateway,
  FlyMachine,
} from "./fly-gateway";

/**
 * Provisioning and teardown against a fake Fly. No network:
 * the gateway is injected, which is the whole reason it exists.
 *
 * What is being pinned here is the *order* and the *survivability*: the volume
 * exists before the machine that mounts it, the ids are on the agent before the
 * next call is made, the machine goes before its volume, and no failure
 * anywhere is allowed to throw at the route that called in.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createDb } = await import("#/db/client");
const { generateConnectorKey } = await import("#/crypto");
const { createAgent, getAgentByIdUnscoped, setAgentComputerRef } = await import(
  "#/modules/agents/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { createHost, getHostByIdUnscoped, redeemEnrollmentCode } = await import(
  "./hosts"
);
const { onAgentComputerCreated, onAgentComputerDeleted } = await import(
  "./lifecycle"
);

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

/** Every call the fake gateway saw, in order, as `method:argument`. */
let trail: string[] = [];
let volumes: CreateVolumeInput[] = [];
let machines: CreateMachineInput[] = [];
let apiTokens: string[] = [];
let failOn: string | null = null;

const refuse = (what: string) => {
  if (failOn === what) {
    throw new Error(`Fly refused to ${what}.`);
  }
};

const fakeGateway = (apiToken: string): FlyGateway => {
  apiTokens.push(apiToken);
  return {
    createMachine: (_app, input) => {
      trail.push("createMachine");
      refuse("create the machine");
      machines.push(input);
      return Promise.resolve({
        config: null,
        id: "m-1",
        state: "created",
      } satisfies FlyMachine);
    },
    createVolume: (_app, input) => {
      trail.push("createVolume");
      refuse("create the volume");
      volumes.push(input);
      return Promise.resolve({ id: "vol-1", name: input.name });
    },
    deleteMachine: (_app, id, options) => {
      trail.push(`deleteMachine:${id}:${options?.force ? "force" : "plain"}`);
      refuse("delete the machine");
      return Promise.resolve();
    },
    deleteVolume: (_app, volumeId) => {
      trail.push(`deleteVolume:${volumeId}`);
      refuse("delete the volume");
      return Promise.resolve();
    },
    getApp: () => Promise.resolve({ name: "agentum-computers", status: "ok" }),
    getMachine: (_app, id) =>
      Promise.resolve({ config: null, id, state: "stopped" }),
    startMachine: (_app, id) => {
      trail.push(`startMachine:${id}`);
      refuse("start the machine");
      return Promise.resolve();
    },
    stopMachine: (_app, id) => {
      trail.push(`stopMachine:${id}`);
      refuse("stop the machine");
      return Promise.resolve();
    },
    updateMachine: (_app, id) =>
      Promise.resolve({ config: null, id, state: "started" }),
  };
};

let db: Db;
let env: Env;
let workspaceId: string;

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  trail = [];
  volumes = [];
  machines = [];
  apiTokens = [];
  failOn = null;
  env = {
    CONNECTOR_KEY: generateConnectorKey(),
    DB: d1,
    PUBLIC_APP_URL: "https://agentum.example.com",
  } as unknown as Env;

  const workspace = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_2aAdaAAAAAAAAAAAAAAAAAAA",
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspaceId = workspace.workspace.id;
});

const newFlyHost = async (config = {}) =>
  (
    await createHost(db, env, workspaceId, {
      config: { app: "agentum-computers", ...config },
      flyApiToken: "fly_api_token",
      kind: "fly",
      name: `fly-${crypto.randomUUID().slice(0, 8)}`,
    })
  ).host;

const newAgent = async (input: {
  computer?: "cloudflare" | "fly" | "self_hosted";
  hostId?: string;
}) => {
  const { agent } = await createAgent(db, workspaceId, {
    computer: input.computer,
    computerHostId: input.hostId,
    instructions: "",
    name: `Agent-${crypto.randomUUID().slice(0, 8)}`,
    soul: "",
  });
  return agent;
};

const refOf = async (agentId: string) =>
  (await getAgentByIdUnscoped(db, agentId))?.computerRef;

const statusOf = async (hostId: string) => {
  const host = await getHostByIdUnscoped(db, hostId);
  return { error: host?.statusError, status: host?.status };
};

describe("provisioning a Fly computer", () => {
  test("creates the volume, then the machine that mounts it", async () => {
    const host = await newFlyHost({ region: "ams", volume_gb: 20 });
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(trail).toEqual(["createVolume", "createMachine"]);
    expect(volumes[0]).toEqual({
      name: `agent_${agent.id.replaceAll("-", "").slice(0, 24)}`,
      region: "ams",
      sizeGb: 20,
    });
    expect(machines[0]?.config.mounts).toEqual([
      { path: "/var/lib/agentum-computer", volume: "vol-1" },
    ]);
    expect(machines[0]?.region).toBe("ams");
    expect(await refOf(agent.id)).toEqual({
      machineId: "m-1",
      volumeId: "vol-1",
    });
  });

  test("the machine connects out with the server URL and an enrollment code", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    const machineEnv = machines[0]?.config.env;
    expect(Object.keys(machineEnv ?? {}).sort()).toEqual([
      "AGENTUM_ENROLL_CODE",
      "AGENTUM_URL",
    ]);
    expect(machineEnv?.AGENTUM_URL).toBe("https://agentum.example.com");
    // The code the machine was given is a live one for this host.
    const redeemed = await redeemEnrollmentCode(
      db,
      machineEnv?.AGENTUM_ENROLL_CODE ?? ""
    );
    expect(redeemed?.host.id).toBe(host.id);
  });

  test("the code outlives the 15 minutes a pasted one gets", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });
    const before = Date.now();

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    const rows = (await env.DB.prepare(
      "SELECT expires_at FROM computer_enrollments WHERE host_id = ?"
    )
      .bind(host.id)
      .raw()) as number[][];
    const day = 24 * 60 * 60 * 1000;
    expect((rows[0]?.[0] ?? 0) - before).toBeGreaterThan(day - 60_000);
  });

  test("the machine has no service for Fly to autostop, and restarts if the client exits", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(machines[0]?.config.services).toBeUndefined();
    expect(machines[0]?.config.restart).toEqual({ policy: "always" });
  });

  test("without PUBLIC_APP_URL nothing is created and the host says why", async () => {
    env = { ...env, PUBLIC_APP_URL: "" } as unknown as Env;
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(trail).toEqual([]);
    expect((await statusOf(host.id)).error).toContain("PUBLIC_APP_URL");
  });

  test("the host's image and instance size win over the defaults", async () => {
    const host = await newFlyHost({
      image: "ghcr.io/acme/agentum-computer:pinned",
      instance: { cpus: 4, memory_mb: 2048 },
    });
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(machines[0]?.config.image).toBe(
      "ghcr.io/acme/agentum-computer:pinned"
    );
    expect(machines[0]?.config.guest).toEqual({
      cpu_kind: "shared",
      cpus: 4,
      memory_mb: 2048,
    });
  });

  test("with nothing configured it falls back to the plan's defaults", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(machines[0]?.config.image).toBe(
      "ghcr.io/codewithpassion/agentum-computer:latest"
    );
    expect(machines[0]?.config.guest).toEqual({
      cpu_kind: "shared",
      cpus: 1,
      memory_mb: 512,
    });
    expect(volumes[0]?.sizeGb).toBe(10);
    // No region configured: Fly's own default (the app's primary region) is a
    // better answer than one this code invented.
    expect(volumes[0]?.region).toBeUndefined();
    expect(machines[0]?.region).toBeUndefined();
  });

  test("the host's Fly API token is what the gateway is built with", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(apiTokens).toEqual(["fly_api_token"]);
  });

  test("the other two backends provision nothing", async () => {
    const cloudflare = await newAgent({ computer: "cloudflare" });
    const { host } = await createHost(db, env, workspaceId, {
      config: {},
      kind: "self_hosted",
      name: "office-box",
    });
    const selfHosted = await newAgent({
      computer: "self_hosted",
      hostId: host.id,
    });

    await onAgentComputerCreated(db, env, cloudflare, fakeGateway);
    await onAgentComputerCreated(db, env, selfHosted, fakeGateway);

    expect(trail).toEqual([]);
  });
});

describe("a provision that fails", () => {
  test("never throws at the route, and says why on the host", async () => {
    failOn = "create the volume";
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    const { error, status } = await statusOf(host.id);
    expect(status).toBe("error");
    expect(error).toContain(agent.name);
    expect(error).toContain("Fly refused to create the volume");
    expect(await refOf(agent.id)).toBeNull();
  });

  test("a machine that failed still leaves the volume id to clean up", async () => {
    failOn = "create the machine";
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(await refOf(agent.id)).toEqual({ volumeId: "vol-1" });
    expect((await statusOf(host.id)).status).toBe("error");
  });

  test("a host with no Fly API token is reported, not attempted", async () => {
    const { host } = await createHost(db, env, workspaceId, {
      config: { app: "agentum-computers" },
      kind: "fly",
      name: "no-token",
    });
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerCreated(db, env, agent, fakeGateway);

    expect(trail).toEqual([]);
    expect((await statusOf(host.id)).error).toContain("no Fly API token");
  });
});

describe("tearing a Fly computer down", () => {
  const provisioned = async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });
    await onAgentComputerCreated(db, env, agent, fakeGateway);
    trail = [];
    return {
      agent: (await getAgentByIdUnscoped(db, agent.id)) ?? agent,
      host,
    };
  };

  test("stops the machine, deletes it, then deletes the volume", async () => {
    const { agent } = await provisioned();

    await onAgentComputerDeleted(db, env, agent, fakeGateway);

    expect(trail).toEqual([
      "stopMachine:m-1",
      "deleteMachine:m-1:force",
      "deleteVolume:vol-1",
    ]);
  });

  test("a machine that will not stop is deleted anyway", async () => {
    const { agent, host } = await provisioned();
    failOn = "stop the machine";

    await onAgentComputerDeleted(db, env, agent, fakeGateway);

    expect(trail).toEqual([
      "stopMachine:m-1",
      "deleteMachine:m-1:force",
      "deleteVolume:vol-1",
    ]);
    expect((await statusOf(host.id)).error).toContain("stop the machine");
  });

  test("a volume Fly would not delete is named on the host, not thrown", async () => {
    const { agent, host } = await provisioned();
    failOn = "delete the volume";

    await onAgentComputerDeleted(db, env, agent, fakeGateway);

    const { error, status } = await statusOf(host.id);
    expect(status).toBe("error");
    expect(error).toContain(agent.name);
    expect(error).toContain("Fly dashboard");
  });

  test("a half-provisioned agent still has its volume removed", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });
    await setAgentComputerRef(db, agent.id, { volumeId: "vol-1" });

    await onAgentComputerDeleted(
      db,
      env,
      (await getAgentByIdUnscoped(db, agent.id)) ?? agent,
      fakeGateway
    );

    expect(trail).toEqual(["deleteVolume:vol-1"]);
  });

  test("an agent that never got a computer calls nothing", async () => {
    const host = await newFlyHost();
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    await onAgentComputerDeleted(db, env, agent, fakeGateway);

    expect(trail).toEqual([]);
  });

  test("a self-hosted agent's container is never touched", async () => {
    const { host } = await createHost(db, env, workspaceId, {
      config: {},
      kind: "self_hosted",
      name: "office-box",
    });
    const agent = await newAgent({ computer: "self_hosted", hostId: host.id });

    await onAgentComputerDeleted(db, env, agent, fakeGateway);

    expect(trail).toEqual([]);
  });
});
