// biome-ignore-all lint/performance/noNamespaceImport: binary protocol test primitives.
// biome-ignore-all lint/performance/noAwaitInLoops: ordered stateful test scenarios.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone Node-hosted Miniflare assertion runner.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as Y from "yjs";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const directory = await mkdtemp(join(tmpdir(), "artifact-room-"));
let runtime;
let passed = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
};
function boot() {
  return new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: "2026-08-19",
      durableObjects: {
        ROOM: { className: "TestArtifactRoom", useSQLite: true },
      },
      modules: true,
      resourcePersistencePath: directory,
      script,
    })
  );
}
async function call(path, input = {}, room = "test") {
  const r = await runtime.dispatchFetch(
    `http://room.test${path}?room=${room}`,
    {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
  if (!r.ok) {
    throw new Error(await r.text());
  }
  return r.json();
}
async function fails(path, input = {}, room = "test") {
  const r = await runtime.dispatchFetch(
    `http://room.test${path}?room=${room}`,
    { body: JSON.stringify(input), method: "POST" }
  );
  check(!r.ok, `${path} should fail`);
}
const ticket = (claims = {}, room = "test") => call("/ticket", claims, room);
async function connect(token, room = "test") {
  const url = new URL(
    `/socket?room=${room}&ticket=${encodeURIComponent(token)}`,
    await runtime.ready
  );
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const messages = [];
  let closed = false;
  ws.addEventListener("message", (event) => messages.push(event.data));
  ws.addEventListener("close", () => {
    closed = true;
  });
  const status = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve(101), { once: true });
    ws.addEventListener("error", () => resolve(403), { once: true });
  });
  await pause(20);
  return {
    get closed() {
      return (
        closed ||
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED
      );
    },
    messages,
    status,
    ws,
  };
}

const controls = (name, value, room = "test") =>
  call("/control", { name, value }, room);
function update(bytes, kind = 2) {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, kind);
  encoding.writeVarUint8Array(e, bytes);
  return encoding.toUint8Array(e);
}
function awareness(id, clock, state) {
  const a = encoding.createEncoder();
  encoding.writeVarUint(a, 1);
  encoding.writeVarUint(a, id);
  encoding.writeVarUint(a, clock);
  encoding.writeVarString(a, JSON.stringify(state));
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint8Array(e, encoding.toUint8Array(a));
  return encoding.toUint8Array(e);
}
function presences(client) {
  return client.messages
    .filter((m) => typeof m !== "string")
    .flatMap((m) => {
      const d = decoding.createDecoder(new Uint8Array(m));
      if (decoding.readVarUint(d) !== 1) {
        return [];
      }
      const a = decoding.createDecoder(decoding.readVarUint8Array(d));
      decoding.readVarUint(a);
      const id = decoding.readVarUint(a);
      const clock = decoding.readVarUint(a);
      return [{ clock, id, state: JSON.parse(decoding.readVarString(a)) }];
    });
}
async function syncReplica(client) {
  const doc = new Y.Doc();
  doc.getXmlFragment("content");
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
  client.ws.send(encoding.toUint8Array(e));
  await pause(50);
  for (const message of client.messages) {
    if (typeof message === "string") {
      continue;
    }
    const d = decoding.createDecoder(new Uint8Array(message));
    if (decoding.readVarUint(d) !== 0) {
      continue;
    }
    const kind = decoding.readVarUint(d);
    if (kind === 1 || kind === 2) {
      Y.applyUpdate(doc, decoding.readVarUint8Array(d));
    }
  }
  return doc;
}
function origin(changeId) {
  return {
    changeId,
    mode: "direct",
    participantId: "agent",
    runId: "run",
    toolCallId: `tool-${changeId}`,
  };
}
try {
  runtime = boot();
  const firstTicket = await ticket();
  const owner = await connect(firstTicket);
  check(owner.status === 101, "valid signed admission");
  check(
    (await connect(firstTicket)).status === 403,
    "single use persisted ticket"
  );
  check(
    (await connect(`${await ticket()}tampered`)).status === 403,
    "signature refused"
  );
  check(
    (await connect(await ticket({ workspaceId: "wrong" }))).status === 403,
    "workspace binding"
  );
  check(
    (
      await connect(
        await ticket({ artifactId: "22345678-1234-4123-8123-123456789abc" })
      )
    ).status === 403,
    "artifact binding"
  );
  const now = Math.floor(Date.now() / 1000);
  check(
    (
      await connect(
        await ticket({
          connectionExpiresAt: now + 700,
          expiresAt: now - 1,
          issuedAt: now - 121,
        })
      )
    ).status === 403,
    "expired ticket"
  );
  const race = await ticket();
  const concurrent = await Promise.all([connect(race), connect(race)]);
  check(
    concurrent.filter((c) => c.status === 101).length === 1,
    "atomic concurrent consume"
  );
  const raceSocket = concurrent.find((c) => c.status === 101);
  raceSocket.ws.close();
  const revokedTicket = await ticket({ participantId: "revoked" });
  await controls("role:revoked", null);
  await call("/refresh", { id: "revoked" });
  check(
    (await connect(revokedTicket)).status === 403,
    "old unexpired ticket after revoke"
  );
  const downgradeTicket = await ticket({ participantId: "downgrade" });
  await controls("role:downgrade", "viewer");
  await call("/refresh", { id: "downgrade" });
  check(
    (await connect(downgradeTicket)).status === 403,
    "old unexpired ticket after downgrade"
  );
  const deletedTicket = await ticket();
  await controls("deleted", true);
  await call("/refresh");
  check(
    (await connect(deletedTicket)).status === 403,
    "old unexpired ticket after deletion"
  );
  await pause(50);
  check(owner.closed, "deletion refresh closes already attached socket");
  await call("/refresh");
  await controls("deleted", false);
  const observer = await connect(await ticket());
  const alice = await connect(await ticket({ participantId: "alice" }));
  alice.ws.send(
    awareness(42, 999_999, {
      status: "spoof",
      user: { color: "#ffffff", id: "victim", name: "Forged" },
    })
  );
  await pause(30);
  const entry = presences(observer).find((p) => p.state?.user?.id === "alice");
  check(
    entry?.state.user.name === "Trusted alice" &&
      entry.state.user.color === "#123456",
    "trusted awareness identity overwritten"
  );
  check(
    entry.clock === 2 && entry.id !== 42,
    `server owns awareness ID and lifecycle clock: ${JSON.stringify(entry)}`
  );
  alice.ws.close();
  await pause(50);
  const cleared = presences(observer).find(
    (p) => p.id === entry.id && p.state === null
  );
  check(cleared?.clock > entry.clock, "monotonic close removal");
  const reconnected = await connect(await ticket({ participantId: "alice" }));
  reconnected.ws.send(awareness(42, 1, { user: { name: "again" } }));
  await pause(30);
  const again = presences(observer)
    .filter((p) => p.state?.user?.id === "alice")
    .at(-1);
  check(
    again.id !== entry.id && again.clock === 2,
    "reconnect uses unique ID immune to poisoned peer clocks"
  );
  // Forged another peer's ID still publishes only the sender's trusted identity.
  reconnected.ws.send(
    awareness(entry.id, Number.MAX_SAFE_INTEGER, {
      user: { id: "owner", name: "spoof" },
    })
  );
  await pause(30);
  check(
    presences(observer).at(-1).id === again.id &&
      presences(observer).at(-1).state.user.id === "alice",
    "cross-peer awareness spoof refused"
  );
  const agent = {
    color: "#ffffff",
    id: "agent",
    kind: "agent",
    name: "Forged Agent",
    status: "Editing",
  };
  await call("/agent", { entry: agent });
  await pause(20);
  check(
    (await call("/presence")).some(
      (p) => p.id === "agent" && p.name === "Trusted agent"
    ),
    "trusted agent broadcast"
  );
  await call("/agent", { entry: null });
  await pause(20);
  check(
    !(await call("/presence")).some((p) => p.id === "agent"),
    "explicit agent clear"
  );
  await call("/agent", { entry: agent });
  const agentId = presences(observer)
    .filter((p) => p.state?.user?.id === "agent")
    .at(-1)?.id;
  await pause(5100);
  check(
    !(await call("/presence")).some((p) => p.id === "agent"),
    "agent expires within five seconds"
  );
  check(
    presences(observer).some((p) => p.id === agentId && p.state === null),
    "agent expiry broadcasts removal"
  );
  // A real Yjs replica syncs and emits a rich content edit through validation.
  const replica = new Y.Doc();
  replica.getXmlFragment("content");
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint8Array(e, Y.encodeStateVector(replica));
  observer.ws.send(encoding.toUint8Array(e));
  await pause(40);
  for (const m of observer.messages) {
    if (typeof m === "string") {
      continue;
    }
    const d = decoding.createDecoder(new Uint8Array(m));
    if (decoding.readVarUint(d) !== 0) {
      continue;
    }
    const k = decoding.readVarUint(d);
    if (k === 1 || k === 2) {
      Y.applyUpdate(replica, decoding.readVarUint8Array(d));
    }
  }
  const paragraph = replica
    .getXmlFragment("content")
    .toArray()
    .find((n) => n.nodeName === "paragraph");
  const text = paragraph.toArray().find((n) => n instanceof Y.XmlText);
  const vector = Y.encodeStateVector(replica);
  text.insert(0, "Human ");
  observer.ws.send(update(Y.encodeStateAsUpdate(replica, vector)));
  await pause(50);
  check(
    (await call("/read")).content.includes("Human Hello"),
    "valid Yjs rich update accepted"
  );
  const goodContent = (await call("/read")).content;
  const hostile = await connect(await ticket());
  const invalid = new Y.Doc();
  const fragment = invalid.getXmlFragment("content");
  const evil = new Y.XmlElement("script");
  fragment.insert(0, [evil]);
  hostile.ws.send(update(Y.encodeStateAsUpdate(invalid)));
  await pause(50);
  check(
    (await call("/read")).content === goodContent,
    "invalid candidate cannot mutate authoritative document"
  );
  check(hostile.closed, "invalid update rejected");
  for (const role of ["viewer", "commenter"]) {
    await controls(`role:${role}`, role);
    const reader = await connect(await ticket({ participantId: role, role }));
    check(reader.status === 101, `${role} admitted`);
    reader.ws.send(update(Y.encodeStateAsUpdate(replica)));
    await pause(30);
    check(
      !reader.closed && (await call("/read")).content === goodContent,
      `${role} cannot write`
    );
  }
  const active = await connect(await ticket({ participantId: "active" }));
  await controls("role:active", "viewer");
  await call("/refresh", { id: "active" });
  active.ws.send(update(Y.encodeStateAsUpdate(replica)));
  await pause(50);
  check(
    !active.closed && (await call("/read")).content === goodContent,
    "refresh downgrades attached writer and refuses writes"
  );
  await controls("role:active", null);
  await call("/refresh", { id: "active" });
  await pause(50);
  check(active.closed, "targeted refresh closes revoked attached socket");
  const stale = await ticket({ participantId: "renew" });
  const renewer = await connect(stale);
  const renewal = await ticket({ participantId: "renew" });
  await controls("role:renew", "viewer");
  renewer.ws.send(JSON.stringify({ ticket: renewal, type: "renew" }));
  await pause(30);
  check(renewer.closed, "renewal reauthorizes and refuses stale role");
  const validRenewal = await ticket();
  observer.ws.send(JSON.stringify({ ticket: validRenewal, type: "renew" }));
  await pause(30);
  check(
    observer.messages.some(
      (m) => typeof m === "string" && JSON.parse(m).type === "renewed"
    ),
    "valid renewal"
  );
  observer.ws.send(JSON.stringify({ ticket: validRenewal, type: "renew" }));
  await pause(30);
  check(observer.closed, "renewal ticket single use");
  const expiring = await connect(await ticket());
  await call("/expire");
  await call("/alarm");
  await pause(150);
  check(
    expiring.closed && (await call("/stats")).sockets === 0,
    "connection expiration alarm removes server sockets"
  );
  // Restart-safe captured agent edits and monotonic authoritative revisions.
  const before = await call("/read");
  const applied = await call("/ops", {
    ops: [{ content: { text: "Agent persisted" }, op: "insert" }],
    origin: origin("persisted"),
  });
  check(
    applied.revision > before.revision,
    "agent advances authoritative revision"
  );
  const duplicate = await call("/ops", {
    ops: [],
    origin: origin("persisted"),
  });
  check(duplicate.revision === applied.revision, "agent change idempotency");
  await fails("/ops", {
    ops: [],
    origin: { ...origin("persisted"), runId: "other" },
  });
  const savedBefore = (await call("/stats")).meta;
  await call("/interrupt");
  check(
    (await call("/stats")).meta.generation === savedBefore.generation,
    "interrupted snapshot generation rolls back atomically"
  );
  await runtime.dispose();
  runtime = boot();
  check(
    (await call("/read")).revision === applied.revision,
    "revision persists through runtime restart"
  );
  await call("/revert", { id: "persisted" });
  check(
    !(await call("/read")).content.includes("Agent persisted") &&
      (await call("/read")).content.includes("Human Hello"),
    "selective revert survives restart and retains human edit"
  );
  await runtime.dispose();
  runtime = boot();
  const reverted = await call("/revert", {
    byParticipant: "another-owner",
    id: "persisted",
  });
  check(
    reverted.byParticipant === "owner",
    "idempotent revert preserves original actor across restart"
  );
  check(
    reverted.revision === (await call("/read")).revision,
    "revert idempotency"
  );
  const currentOutline = (await call("/outline")).content;
  const heading = currentOutline.blocks.find((b) => b.type === "heading");
  await call("/ops", {
    ops: [
      {
        attrs: { level: 2 },
        blockId: heading.id,
        ifHash: heading.hash,
        ifRev: heading.revision,
        op: "set",
      },
    ],
    origin: origin("guard-after-restart"),
  });
  check(
    (await call("/read")).content.startsWith("## Fixture"),
    "persisted per-block guard revisions survive unrelated edits and restart"
  );
  const anchor = await call("/anchor", { word: "Hello" });
  check(
    (await call("/resolve-anchor", { anchor })).quote === "Hello",
    "anchor adapter resolves live relative positions"
  );
  const paragraphBlock = (await call("/outline")).content.blocks.find((b) =>
    b.text.includes("Hello")
  );
  await fails("/ops", {
    ops: [
      {
        ifHash: paragraphBlock.hash,
        ifRev: paragraphBlock.revision,
        op: "delete",
        target: { blockId: paragraphBlock.id },
      },
    ],
    origin: origin("protected-delete"),
  });
  await fails("/guard-snapshot");
  check(
    (await call("/read")).content.includes("Hello"),
    "agent operations and snapshots refuse anchored-word deletion"
  );
  await controls("ranges", []);
  // Restore applied once, then DB save failure, then restart/checkpoint retry with provenance.
  const restore = await call("/restore", {
    byParticipant: "owner",
    requestId: "restore-once",
    versionId: "version-old",
  });
  await controls("failSave", true);
  await fails("/checkpoint");
  const { pending } = await call("/stats");
  check(
    pending.restores.some((r) => r.requestId === "restore-once"),
    "restore provenance retained in durable pending checkpoint"
  );
  await runtime.dispose();
  runtime = boot();
  const retried = await call("/restore", {
    byParticipant: "owner",
    requestId: "restore-once",
    versionId: "version-old",
  });
  check(
    retried.revision === restore.revision &&
      (await call("/read")).revision === restore.revision,
    "restore retry after failed save does not restore twice"
  );
  await controls("failSave", false);
  await controls("failAfterSave", true);
  await fails("/checkpoint");
  const committed = (await call("/stats")).fixture.saved;
  const acknowledged = await call("/checkpoint");
  check(
    acknowledged.revision === committed.revision &&
      !(await call("/stats")).pending,
    "lost save acknowledgement reconciles idempotently"
  );
  check(
    (await call("/stats")).fixture.saved.restores[0].versionId ===
      "version-old",
    "checkpoint retains restore provenance"
  );
  await call(
    "/ops",
    {
      ops: [
        {
          content: {
            json: {
              content: [
                { attrs: { src: "/files/own-image.png" }, type: "image" },
              ],
              type: "doc",
            },
          },
          op: "insert",
        },
      ],
      origin: origin("own-image"),
    },
    "images"
  );
  check(
    (await call("/read", {}, "images")).content.includes(
      "/files/own-image.png"
    ),
    "image policy comes from trusted service port"
  );
  const imageClient = await connect(await ticket({}, "images"), "images");
  const imageDoc = await syncReplica(imageClient);
  const image = imageDoc
    .getXmlFragment("content")
    .toArray()
    .find((n) => n.nodeName === "image");
  const imageVector = Y.encodeStateVector(imageDoc);
  image.setAttribute("src", "/files/foreign-image.png");
  imageClient.ws.send(update(Y.encodeStateAsUpdate(imageDoc, imageVector)));
  await pause(50);
  check(
    !(await call("/read", {}, "images")).content.includes("foreign-image"),
    "binary update cannot grant itself ownership of an image"
  );
  imageDoc.destroy();
  // 512 KiB chunks, 1 MiB compaction, 8 MiB cap and recovered multi-MiB state.
  await call("/seed", { markdown: "x".repeat(1_300_000) }, "large");
  let stats = await call("/stats", {}, "large");
  check(
    stats.meta.generation > 1 &&
      stats.chunks.find((c) => c.kind === "snapshot").n >= 3,
    "1 MiB triggers chunked compaction"
  );
  check(
    stats.chunks.every((c) => c.max <= 512 * 1024),
    "all SQLite blobs bounded to 512 KiB"
  );
  await fails("/seed", { markdown: "x".repeat(8 * 1024 * 1024 + 1) }, "large");
  check(
    (await call("/read", {}, "large")).content.length < 8 * 1024 * 1024,
    "oversized document refused"
  );
  await runtime.dispose();
  runtime = boot();
  check(
    (await call("/read", {}, "large")).content.includes("x".repeat(1_000_000)),
    "multi-chunk generation recovers after restart"
  );
  await call("/seed", { markdown: "z".repeat(5 * 1024 * 1024) }, "five-mb");
  const five = await call("/stats", {}, "five-mb");
  check(
    five.chunks.find((c) => c.kind === "snapshot").n >= 10,
    "5 MiB document stored below SQLite row limit"
  );
  // A persisted due deadline triggers periodic checkpoint after a restart.
  await call(
    "/ops",
    {
      ops: [{ content: { text: "periodic" }, op: "insert" }],
      origin: origin("periodic"),
    },
    "periodic"
  );
  await call("/checkpoint-due", {}, "periodic");
  await runtime.dispose();
  runtime = boot();
  await call("/alarm", {}, "periodic");
  check(
    (await call("/stats", {}, "periodic")).fixture.saved?.origins[0]
      .changeId === "periodic",
    "five-minute checkpoint deadline survives restart"
  );
  // Count-based compaction without reaching the byte threshold.
  for (let i = 0; i < 500; i += 1) {
    await call(
      "/ops",
      {
        ops: [{ content: { text: `small-${i}` }, op: "insert" }],
        origin: origin(`small-${i}`),
      },
      "count"
    );
  }
  stats = await call("/stats", {}, "count");
  check(
    stats.meta.generation === 2 && stats.meta.baseSequence === 500,
    "500 updates compact atomically"
  );
  // Hibernation evidence: actual workerd constructor reruns while sockets remain open.
  const sleeper = await connect(await ticket({}, "hibernate"), "hibernate");
  sleeper.ws.send(awareness(1, 1, {}));
  await pause(30);
  const sleepyDoc = await syncReplica(sleeper);
  const { starts } = (await call("/stats", {}, "hibernate")).fixture;
  await pause(12_000);
  sleeper.ws.send(awareness(1, 2, {}));
  await pause(50);
  stats = await call("/stats", {}, "hibernate");
  check(
    !sleeper.closed && stats.sockets === 1,
    "socket survives idle workerd hibernation"
  );
  check(
    stats.fixture.starts > starts,
    "constructor reentered after local hibernation"
  );
  check(
    (await call("/presence", {}, "hibernate"))[0].name === "Trusted owner",
    "awareness attachments recover after wake"
  );
  const sleepyParagraph = sleepyDoc
    .getXmlFragment("content")
    .toArray()
    .find((n) => n.nodeName === "paragraph");
  const sleepyText = sleepyParagraph
    .toArray()
    .find((n) => n instanceof Y.XmlText);
  const sleepyVector = Y.encodeStateVector(sleepyDoc);
  sleepyText.insert(0, "Wake ");
  sleeper.ws.send(update(Y.encodeStateAsUpdate(sleepyDoc, sleepyVector)));
  await pause(50);
  check(
    (await call("/read", {}, "hibernate")).content.includes("Wake Hello"),
    "rich Yjs edits continue after socket hibernation"
  );
  sleepyDoc.destroy();
  sleeper.ws.close();
  const last = await connect(await ticket({}, "last"), "last");
  await call(
    "/ops",
    {
      ops: [{ content: { text: "checkpoint on leave" }, op: "insert" }],
      origin: origin("leave"),
    },
    "last"
  );
  last.ws.close();
  await pause(100);
  check(
    (await call("/stats", {}, "last")).fixture.saved?.origins[0].changeId ===
      "leave",
    "last participant checkpoints with agent provenance"
  );
  process.stdout.write(
    JSON.stringify({
      hibernation: { after: stats.fixture.starts, before: starts },
      passed,
    })
  );
} catch (error) {
  process.stdout.write(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
  await rm(directory, { force: true, recursive: true });
}
