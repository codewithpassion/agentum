// biome-ignore-all lint/performance/noAwaitInLoops: ordered integration scenario and migrations.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd integration runner.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const directory = await mkdtemp(join(tmpdir(), "live-production-"));
const options = {
  bindings: {
    ALLOWED_ORG_IDS: "org_w1",
    ARTIFACT_LINKS_OFF: "",
    ARTIFACT_VIEW_KEY: "production-integration-private-test-key",
    CLERK_SECRET_KEY: "sk_test_fixture",
    MAIL_DOMAIN: "",
    PUBLIC_BASE_URL: "http://localhost",
    RUN_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
    SECRETS_KEY: Buffer.alloc(32, 8).toString("base64"),
  },
  compatibilityDate: "2026-08-19",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  durableObjects: {
    ARTIFACT_ROOM: { className: "ArtifactRoom", useSQLite: true },
    LIVE_ARTIFACT_MAINTENANCE: {
      className: "LiveArtifactMaintenance",
      useSQLite: true,
    },
  },
  modules: true,
  r2Buckets: ["FILES"],
  resourcePersistencePath: directory,
  script,
};
let runtime = new Miniflare(convertV4MiniflareOptions(options));
let passed = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  passed++;
};
try {
  const db = await runtime.getD1Database("DB");
  const migrations = resolve(
    import.meta.dirname,
    "../../../../../../packages/db/migrations"
  );
  for (const name of (await readdir(migrations))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(join(migrations, name), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const now = new Date().toISOString(),
    lease = new Date(Date.now() + 3_600_000).toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspaces (id,clerk_org_id,name,timezone,created_at) VALUES ('w1','org_w1','Fixture','UTC',?)"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO agents (id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES ('a1','w1','u1',?,'','model','Fixture Agent','machine','{}','fixture','active')"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO sessions (id,workspace_id,agent_id,actor_id,actor_kind,created_at,origin) VALUES ('s1','w1','a1','u1','user',?,'ui')"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO runs (id,workspace_id,agent_id,session_id,actor_id,actor_kind,created_at,input_text,status,lease_until,on_behalf_of_user_id) VALUES ('r1','w1','a1','s1','u1','user',?,'','running',?,'u1')"
      )
      .bind(now, lease),
  ]);
  let response = await runtime.dispatchFetch("http://localhost/fixture/token", {
    method: "POST",
  });
  const { token } = await response.json();
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let rpcId = 0;
  const mcp = async (name, args) => {
    const r = await runtime.dispatchFetch("http://localhost/mcp", {
      body: JSON.stringify({
        id: ++rpcId,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers,
      method: "POST",
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`${r.status}: ${text}`);
    }
    const raw =
      text.startsWith("event:") || text.startsWith("data:")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .at(-1)
            .slice(5)
            .trim()
        : text;
    const result = JSON.parse(raw);
    if (result.error || result.result?.isError) {
      throw new Error(JSON.stringify(result));
    }
    return result.result.structuredContent;
  };
  const created = await mcp("artifact_create", {
    kind: "document",
    markdown: "# Fixture\n\nHello human words here.",
    title: "Production fixture",
  });
  check(Boolean(created.artifactId), "run token artifact_create");
  const read = await mcp("document_read", { artifactId: created.artifactId });
  check(
    read.blocks.some((b) => b.text === "Hello human words here."),
    "real room loaded R2 checkpoint"
  );
  const target = read.blocks.find((b) => b.text === "Hello human words here.");
  const edit = await mcp("document_edit", {
    artifactId: created.artifactId,
    ops: [
      {
        content: { text: "Agent edited actual room." },
        op: "replace",
        target: { blockId: target.id, ifHash: target.hash, ifRev: target.rev },
      },
    ],
    summary: "Fixture edit",
  });
  check(edit.revision > read.revision, "MCP edit advanced room");
  const persisted = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    persisted.markdown.includes("Agent edited actual room."),
    "R2/DB checkpoint roundtrip"
  );
  const versions = await db
    .prepare("SELECT count(*) as n FROM artifact_versions WHERE artifact_id=?")
    .bind(created.artifactId)
    .first();
  check(versions.n === 2, "one durable edit checkpoint");
  const changes = await db
    .prepare("SELECT * FROM artifact_live_changes WHERE artifact_id=?")
    .bind(created.artifactId)
    .all();
  check(
    changes.results.length === 1 && changes.results[0].id === edit.changeId,
    "durable room change reconciled"
  );
  const checkpoint = await runtime.dispatchFetch(
    `http://localhost/fixture/checkpoint/${created.artifactId}`,
    { headers, method: "POST" }
  );
  check(checkpoint.ok, "clean checkpoint acknowledgement is idempotent");
  response = await runtime.dispatchFetch(
    `http://localhost/fixture/join/${created.artifactId}`,
    { headers, method: "POST" }
  );
  const admission = await response.json();
  const socketUrl = `http://localhost${admission.roomUrl}?ticket=${encodeURIComponent(admission.ticket)}`;
  const denied = await runtime.dispatchFetch(socketUrl, {
    headers: { Upgrade: "websocket" },
  });
  check(denied.status === 401, "ticket without real credential denied");
  const socket = await runtime.dispatchFetch(socketUrl, {
    headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
  });
  check(socket.status === 101, "authenticated initial request accepted");
  socket.webSocket.accept();
  const replay = await runtime.dispatchFetch(socketUrl, {
    headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
  });
  check(replay.status === 403, "room replay consumed durably");
  socket.webSocket.close();
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const recovered = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    recovered.markdown === persisted.markdown,
    "R2 D1 persistence across runtime restart"
  );
  console.log(JSON.stringify({ passed }));
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
