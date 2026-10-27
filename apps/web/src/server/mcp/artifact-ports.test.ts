import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { taskFolderPath } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import type {
  ArtifactTestBrowser,
  ArtifactTestPage,
  TestPageListeners,
} from "../artifact-test/driver.ts";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

const TOOLS = [
  "artifact_create",
  "artifact_list",
  "artifact_read",
  "artifact_test",
  "artifact_update",
];
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const HOST = "https://hm.example.com";

let composed: Composed;
let user: Extract<Principal, { kind: "user" }>;
let run: Extract<Principal, { kind: "run" }>;
let visited: string[];

/** A browser with a canned page: one console error, one 404, a PNG. No network. */
const fakeBrowser: ArtifactTestBrowser = {
  open: () => {
    let listeners: TestPageListeners | undefined;
    const page: ArtifactTestPage = {
      goto: (url) => {
        visited.push(url);
        listeners?.console({ text: "boom in page script", type: "error" });
        listeners?.response({
          status: 404,
          url: "https://cdn.example.com/x.js",
        });
        return Promise.resolve();
      },
      listen: (next) => {
        listeners = next;
      },
      screenshot: () => Promise.resolve(PNG),
      settle: () => Promise.resolve(),
      snapshot: () =>
        Promise.resolve({
          links: [],
          text: "Hello from the page",
          title: "Canned page",
          url: "https://x",
        }),
    };
    return Promise.resolve({ close: () => Promise.resolve(), page });
  },
};

beforeEach(async () => {
  visited = [];
  const db = migrated();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      artifactViewKey: "test-view-key",
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
      secretsKey: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).toString("base64"),
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
  const agent = await composed.services.agents.create(user, {
    model: "fake",
    name: "builder",
    runtime: "fake",
    slug: "builder",
  });
  const started = await composed.services.runs.startRun(user, {
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "mcp" },
  });
  run = {
    agentId: agent.id,
    kind: "run",
    runId: started.runId,
    workspaceId: workspace.id,
  };
});

const connect = async () => {
  const ports = createMcpPorts({
    artifactTestBrowser: fakeBrowser,
    principal: run,
    publicBaseUrl: HOST,
    services: composed.services,
  });
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(ports, {})
  );
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ arguments: args, name });
      const text = JSON.stringify(result.content ?? []);
      return {
        data: (result.structuredContent ?? {}) as Record<string, unknown>,
        isError: result.isError === true,
        text,
      };
    },
    client,
    close,
  };
};

test("a run publishes, updates, reads, lists and tests an artifact", async () => {
  const session = await connect();
  try {
    const listedTools = (await session.client.listTools()).tools.map(
      (tool) => tool.name
    );
    for (const name of TOOLS) {
      expect(listedTools).toContain(name);
    }

    const created = await session.call("artifact_create", {
      files: [{ path: "index.html", text: "<h1>Hello</h1>" }],
      kind: "page",
      title: "Hello page",
    });
    expect(created.isError).toBe(false);
    const artifactId = created.data.artifactId as string;
    expect(created.data.version).toBe(1);
    expect(created.data.url).toBe(`${HOST}/a/${artifactId}`);
    const stored = await composed.services.artifacts.get(user, artifactId);
    expect(stored.title).toBe("Hello page");

    const updated = await session.call("artifact_update", {
      artifactId,
      baseVersion: 1,
      files: [{ path: "index.html", text: "<h1>Hello again</h1>" }],
    });
    expect(updated.isError).toBe(false);
    expect(updated.data.version).toBe(2);

    const stale = await session.call("artifact_update", {
      artifactId,
      baseVersion: 1,
      files: [{ path: "index.html", text: "<h1>Late</h1>" }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("conflict");
    expect(stale.text).toContain("current version is 2");

    const read = await session.call("artifact_read", { artifactId });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Hello again");
    expect(read.data.currentVersion).toBe(2);

    const listed = await session.call("artifact_list", {});
    expect(JSON.stringify(listed.data)).toContain(artifactId);

    const tested = await session.call("artifact_test", { artifactId });
    expect(tested.isError).toBe(false);
    expect(tested.text).toContain("boom in page script");
    expect(tested.text).toContain("https://cdn.example.com/x.js");
    expect(tested.data.version).toBe(2);
    expect(visited).toHaveLength(1);
    expect(visited[0]).toContain(`${HOST}/a/${artifactId}/c/`);

    const screenshotPath = tested.data.screenshotPath as string;
    expect(
      screenshotPath.startsWith(`${taskFolderPath("builder", run.runId)}/`)
    ).toBe(true);
    const saved = await composed.services.library.read(run, screenshotPath);
    expect(JSON.stringify(saved)).toBeDefined();
    expect(
      (await composed.services.artifacts.get(user, artifactId)).hasThumbnail
    ).toBe(true);

    for (const output of [tested.text, JSON.stringify(tested.data)]) {
      expect(output).not.toContain("hm_view_");
      expect(output).not.toContain("/c/");
    }
  } finally {
    await session.close();
  }
});

test("a phone test leaves the thumbnail alone and an unknown version is not found", async () => {
  const session = await connect();
  try {
    const created = await session.call("artifact_create", {
      files: [{ path: "index.html", text: "<h1>Hi</h1>" }],
      kind: "page",
      title: "Phone",
    });
    const artifactId = created.data.artifactId as string;
    const phone = await session.call("artifact_test", {
      artifactId,
      viewport: "phone",
    });
    expect(phone.isError).toBe(false);
    expect((phone.data.screenshotPath as string).includes("-phone-")).toBe(
      true
    );
    expect(
      (await composed.services.artifacts.get(user, artifactId)).hasThumbnail
    ).toBe(false);
    const missing = await session.call("artifact_test", {
      artifactId,
      version: 9,
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("not_found");
  } finally {
    await session.close();
  }
});
