import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { migrated } from "@repo/db/test-db";
import { createAgentumMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
let agentId: string;
let person: Principal;
let slug: string;
let run: Principal;

beforeEach(async () => {
  db = migrated(["org_a"]);
  composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      libraryBlobs: memoryLibraryBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  person = { kind: "user", userId: "user_1", via: "session", workspaceId };
  const agent = await composed.services.agents.create(person, {
    model: "fake",
    name: "Scribe",
    runtime: "fake",
  });
  ({ slug } = agent);
  agentId = agent.id;
  const started = await composed.services.runs.startRun(person, {
    agentId: agent.id,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  run = { agentId: agent.id, kind: "run", runId: started.runId, workspaceId };
});

const connect = async (principal: Principal) => {
  const ports = createMcpPorts({ principal, services: composed.services });
  const { client } = await connectClient(createAgentumMcpServer(ports));
  return (name: string, args: Record<string, unknown>) =>
    client.callTool({ arguments: args, name });
};

/** A run in a ui session opened by the person it acts for, which is where private notes are visible. */
const insertRun = (runId: string, onBehalfOfUserId: string | null) => {
  db.insert(sessionRows)
    .values({
      actorId: onBehalfOfUserId ?? "user_1",
      actorKind: "user",
      agentId,
      createdAt: new Date().toISOString(),
      id: `sess_${runId}`,
      origin: "ui",
      workspaceId,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "user_1",
      actorKind: "user",
      agentId,
      createdAt: new Date().toISOString(),
      id: runId,
      inputFileIds: "[]",
      inputText: "hi",
      onBehalfOfUserId,
      outputFileIds: "[]",
      sessionId: `sess_${runId}`,
      status: "running",
      workspaceId,
    })
    .run();
  const principal: Principal = { agentId, kind: "run", runId, workspaceId };
  return principal;
};

const dataOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

test("an agent writes its task folder, then lists, reads and versions the file", async () => {
  const call = await connect(run);
  const path = `agents/${slug}/tasks/t1/out.md`;
  const wrote = await call("library_write", { content: "hello", path });
  expect(wrote.isError).toBeFalsy();

  const listed = await call("library_list", { dir: `agents/${slug}/tasks/t1` });
  const entries = dataOf(listed).entries as { path: string }[];
  expect(entries.map((entry) => entry.path)).toEqual([path]);

  const read = await call("library_read", { path });
  expect(dataOf(read)).toMatchObject({ content: "hello", encoding: "text" });

  const versions = await call("library_versions", { path });
  const history = dataOf(versions).versions as {
    authorKind: string;
    op: string;
  }[];
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ authorKind: "agent", op: "write" });
});

test("a write with a stale etag is a conflict, and a write outside the agent's scope is refused", async () => {
  const call = await connect(run);
  const path = `agents/${slug}/tasks/t1/a.md`;
  const first = dataOf(await call("library_write", { content: "one", path }))
    .entry as { etag: string };
  await composed.services.library.write(
    person,
    path,
    new TextEncoder().encode("two")
  );
  const stale = await call("library_write", {
    content: "three",
    ifEtag: first.etag,
    path,
  });
  expect(stale.isError).toBe(true);
  expect(dataOf(stale).code).toBe("conflict");

  const outside = await call("library_write", {
    content: "x",
    path: "shared/notes.md",
  });
  expect(outside.isError).toBe(true);
});

test("wiki_read returns the page with its links, and an agent's suggestion waits for review", async () => {
  await composed.services.library.write(
    person,
    "wiki/home.md",
    new TextEncoder().encode("# Home\nSee [[Missing]]\n")
  );
  const call = await connect(run);
  const page = dataOf(await call("wiki_read", { path: "wiki/home.md" }));
  expect(page.title).toBe("Home");
  expect((page.links as { broken: boolean }[])[0]?.broken).toBe(true);

  const suggested = await call("wiki_suggest_edit", {
    body: "# Home\nBetter\n",
    path: "wiki/home.md",
    summary: "Tidy up",
  });
  expect(suggested.isError).toBeFalsy();
  const { suggestionId } = dataOf(suggested) as { suggestionId: string };
  const open = await composed.services.wikiSuggestions.list(person);
  expect(open.map((row) => row.id)).toContain(suggestionId);
  // The page itself is unchanged until a person accepts.
  const after = await composed.services.library.read(person, "wiki/home.md");
  expect(new TextDecoder().decode(after.bytes)).toBe(
    "# Home\nSee [[Missing]]\n"
  );
});

test("an agent's library tools show only the private notes of the person its run acts for", async () => {
  const memory = `agents/${slug}/memory`;
  const privateDir = `${memory}/private`;
  const privateFile = `${privateDir}/user_a.md`;
  const shared = `${memory}/people.md`;
  const userA: Principal = {
    kind: "user",
    userId: "user_a",
    via: "session",
    workspaceId,
  };
  await composed.services.library.writeMemoryFiles(
    userA,
    [{ bytes: new TextEncoder().encode("a notes"), path: privateFile }],
    () => []
  );
  await composed.services.library.write(
    person,
    shared,
    new TextEncoder().encode("shared")
  );

  const cases = [
    {
      name: "for user_a",
      principal: insertRun("run_for_a", "user_a"),
      sees: true,
    },
    {
      name: "for user_b",
      principal: insertRun("run_for_b", "user_b"),
      sees: false,
    },
    {
      name: "with no person",
      principal: insertRun("run_no_person", null),
      sees: false,
    },
  ];
  const checks = await Promise.all(
    cases.map(async (item) => ({
      ...item,
      call: await connect(item.principal),
    }))
  );
  await Promise.all(
    checks.map(async ({ call, name, sees }) => {
      const listedMemory = dataOf(await call("library_list", { dir: memory }));
      expect(
        (listedMemory.entries as { path: string }[]).map((entry) => entry.path),
        name
      ).toEqual([shared, privateDir]);

      const listedPrivate = dataOf(
        await call("library_list", { dir: privateDir })
      );
      expect(
        (listedPrivate.entries as { path: string }[]).map(
          (entry) => entry.path
        ),
        name
      ).toEqual(sees ? [privateFile] : []);

      const readShared = await call("library_read", { path: shared });
      expect(readShared.isError, name).toBeFalsy();
      expect(dataOf(readShared), name).toMatchObject({
        content: "shared",
        encoding: "text",
      });

      const readPrivate = await call("library_read", { path: privateFile });
      if (sees) {
        expect(readPrivate.isError, name).toBeFalsy();
        expect(dataOf(readPrivate), name).toMatchObject({
          content: "a notes",
          encoding: "text",
        });
      } else {
        expect(readPrivate.isError, name).toBe(true);
      }
    })
  );
});
