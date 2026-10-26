import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { migrated } from "@repo/db/test-db";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import type { BrowserDriver, BrowserPage } from "@repo/services/browser/types";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts, resolveRunComputer } from "./ports.ts";

const PAGE_URL = "https://example.com/";
const MACHINE_ID = "machine_1";

let composed: Composed;
let db: Composed["db"];
let workspaceId: string;
let userPrincipal: Principal;
let navigations: string[];
let relayCalls: string[];

const page: BrowserPage = {
  click: () => Promise.resolve(),
  fill: () => Promise.resolve(),
  navigate: (url) => {
    navigations.push(url);
    return Promise.resolve();
  },
  release: () => Promise.resolve(),
  screenshot: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])),
  snapshot: () =>
    Promise.resolve({
      links: [],
      text: "Example Domain",
      title: "Example",
      url: PAGE_URL,
    }),
};
const driver: BrowserDriver = {
  connect: () => Promise.resolve(page),
  launch: () => Promise.resolve({ page, sessionId: "session-1" }),
};

beforeEach(async () => {
  navigations = [];
  relayCalls = [];
  const database = migrated();
  db = database;
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db: database,
    infra: {
      atomic: sqliteAtomic(database),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      browserDriver: driver,
      clock: { now: () => new Date(), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: {
        ...noopRelay,
        computerExec: (machineId) => {
          relayCalls.push(machineId);
          return Promise.resolve({
            ok: true,
            resultJson: JSON.stringify({
              bytes_total: 3,
              duration_ms: 4,
              exit_code: 0,
              stderr: "",
              stdout: "hi\n",
              truncated: false,
            }),
          });
        },
        computerStatus: () =>
          Promise.resolve({
            ...{
              capabilities: null,
              connected: true,
              control: null,
              hostname: "box",
              inFlightExec: 0,
              lastSeenAt: null,
              queued: 0,
              version: "1",
            },
            workdir: "/work",
          }),
      },
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId,
  };
});

const runAs = async (attachComputer: boolean): Promise<Principal> => {
  const agent = await composed.services.agents.create(userPrincipal, {
    model: "fake",
    name: "Agent",
    runtime: "fake",
  });
  if (attachComputer) {
    db.insert(machines)
      .values({
        capabilities: "{}",
        computerCapabilities: JSON.stringify({ desktop: true }),
        computerStatus: "online",
        createdAt: new Date().toISOString(),
        credentialHash: "computer-only:x",
        enrolledBy: "user_1",
        id: MACHINE_ID,
        name: "Box",
        singleUser: false,
        status: "offline",
        workspaceId,
      })
      .run();
    db.update(agents)
      .set({ computerMachineId: MACHINE_ID })
      .where(eq(agents.id, agent.id))
      .run();
  }
  const { runId } = await composed.services.runs.startRun(userPrincipal, {
    agentId: agent.id,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  return { agentId: agent.id, kind: "run", runId, workspaceId };
};

/** An MCP session the way `/mcp` builds one for `principal`. */
const connect = async (principal: Principal) => {
  const computer = await resolveRunComputer(composed.services, principal);
  const ports = createMcpPorts({
    computerMachineId: computer?.machineId,
    principal,
    relay: composed.relay,
    services: composed.services,
  });
  const server = createHarbourmasterMcpServer(ports, {
    browser: principal.kind === "run",
    computer: computer ? { desktop: computer.desktop } : undefined,
  });
  const { client, close } = await connectClient(server);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close,
    listToolNames: async () =>
      (await client.listTools()).tools.map((tool) => tool.name),
  };
};

test("a run with no computer gets the browser tools and no computer tools", async () => {
  const session = await connect(await runAs(false));
  const names = await session.listToolNames();
  expect(names).toContain("browser_navigate");
  expect(names).toContain("browser_snapshot");
  expect(names).not.toContain("computer_exec");
  expect(names).not.toContain("desktop_input");
  const result = await session.call("browser_navigate", { url: PAGE_URL });
  expect(result.isError).toBeFalsy();
  expect(navigations).toEqual([PAGE_URL]);
  await session.close();
});

test("a run whose agent has a computer gets the computer tools, desktop included", async () => {
  const principal = await runAs(true);
  expect(await resolveRunComputer(composed.services, principal)).toEqual({
    desktop: true,
    machineId: MACHINE_ID,
  });
  const session = await connect(principal);
  const names = await session.listToolNames();
  expect(names).toContain("computer_exec");
  expect(names).toContain("desktop_input");
  const result = await session.call("computer_exec", { command: "echo hi" });
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.structuredContent)).toContain("hi");
  expect(relayCalls).toEqual([MACHINE_ID]);
  await session.close();
});

test("a revoked computer is no computer", async () => {
  const principal = await runAs(true);
  db.update(machines)
    .set({ status: "revoked" })
    .where(eq(machines.id, MACHINE_ID))
    .run();
  expect(await resolveRunComputer(composed.services, principal)).toBeNull();
});

test("a person gets neither the browser nor the computer tools", async () => {
  expect(await resolveRunComputer(composed.services, userPrincipal)).toBeNull();
  const session = await connect(userPrincipal);
  const names = await session.listToolNames();
  expect(names.some((name) => name.startsWith("browser_"))).toBe(false);
  expect(names).not.toContain("computer_exec");
  await session.close();
});
