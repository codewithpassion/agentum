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
const directory = await mkdtemp(join(tmpdir(), "deck-room-"));
let runtime;
let passed = 0;
const slide = (id, order) =>
  `<slide id="${id}" order="${order}" background="#fff" transition="none" duration="0"><notes>speaker notes</notes><element id="${id}e1" type="text" parent="${id}" order="a0" prop-x="0" prop-y="0" prop-w="100" prop-h="50"><p>Hello human</p></element><element id="${id}e2" type="shape" parent="${id}" order="a1" prop-x="20" prop-y="20" prop-w="50" prop-h="50" prop-shape="rect"></element></slide>`;
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
  doc.getMap("meta");
  doc.getMap("slides");
  doc.getMap("sections");
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

try {
  runtime = boot();
  await controls("deck", true);
  await controls("slides", [slide("s1", "a0"), slide("s2", "a1")]);
  await call("/snapshot");
  const t = await ticket();
  const one = await connect(t),
    two = await connect(await ticket({ participantId: "editor" }));
  check(
    one.status === 101 && two.status === 101,
    "two actual deck clients admitted"
  );
  check((await connect(t)).status === 403, "ticket cannot be replayed");
  const hello = one.messages
    .filter((m) => typeof m === "string")
    .map(JSON.parse)
    .find((m) => m.type === "session");
  check(
    hello.kind === "deck" &&
      hello.participant.name === "Trusted owner" &&
      hello.role === "owner" &&
      !!hello.epoch,
    "trusted complete hello"
  );
  const a = await syncReplica(one),
    b = await syncReplica(two);
  check(
    a.getMap("meta").has("theme"),
    "theme initialized before distributing replicas"
  );
  const av = Y.encodeStateVector(a),
    bv = Y.encodeStateVector(b);
  a.getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props")
    .set("x", "40");
  b.getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props")
    .set("y", "70");
  one.ws.send(update(Y.encodeStateAsUpdate(a, av)));
  two.ws.send(update(Y.encodeStateAsUpdate(b, bv)));
  await pause(120);
  const snap = await call("/snapshot");
  const combined = new Y.Doc();
  Y.applyUpdate(combined, Uint8Array.from(snap.state));
  const props = combined
    .getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props");
  check(
    props.get("x") === "40" && props.get("y") === "70",
    "independent concurrent properties survive room admission"
  );
  const moveA = await syncReplica(one),
    moveB = await syncReplica(two);
  const va = Y.encodeStateVector(moveA),
    vb = Y.encodeStateVector(moveB);
  moveA.getMap("slides").get("s2").set("order", "a3");
  moveB.getMap("slides").get("s2").set("order", "a4");
  const makeSlide = (order) =>
    new Y.Map(
      Object.entries({
        background: "#fff",
        duration: "0",
        elements: new Y.Map(),
        layout: new Y.Map(),
        notes: new Y.Text(),
        order,
        transition: "none",
      })
    );
  moveA.getMap("slides").set("concurrentA", makeSlide("a5"));
  moveB.getMap("slides").set("concurrentB", makeSlide("a6"));
  one.ws.send(update(Y.encodeStateAsUpdate(moveA, va)));
  two.ws.send(update(Y.encodeStateAsUpdate(moveB, vb)));
  await pause(100);
  const moved = await call("/deck-read");
  check(
    moved.deck.order.filter((id) => id === "s2").length === 1 &&
      moved.deck.order.includes("concurrentA") &&
      moved.deck.order.includes("concurrentB"),
    "concurrent slide moves leave one copy and independent slides both survive"
  );
  moveA.destroy();
  moveB.destroy();
  const duplicateRevision = (await call("/snapshot")).revision;
  one.ws.send(update(Y.encodeStateAsUpdate(a, av)));
  await pause(60);
  check(
    (await call("/snapshot")).revision === duplicateRevision,
    "duplicate original Yjs updates do not create revisions or checkpoints"
  );
  const read = await call("/deck-read");
  const current = await syncReplica(two),
    vec = Y.encodeStateVector(current);
  current
    .getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props")
    .set("x", "41");
  current
    .getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props")
    .set("x", "40");
  two.ws.send(update(Y.encodeStateAsUpdate(current, vec)));
  await pause(100);
  const observed = read.slides.find((s) => s.id === "s1");
  const written = await call("/deck-write", {
    changeId: "guarded",
    ops: [
      {
        html: observed.html
          .replace('x="40"', 'x="90"')
          .replace('x="20"', 'x="30"'),
        op: "write",
        revision: observed.revision,
        slideId: "s1",
      },
    ],
  });
  check(
    written.skipped.some((s) => s.id === "s1e1"),
    "remote edit/revert invalidates opaque element guard"
  );
  check(
    written.applied.some((s) => s.keys.includes("s1e2")),
    "untouched element still merges"
  );
  const calls = await call("/stats");
  check(
    calls.meta.origins.some((o) => o.changeId === "guarded"),
    "guarded result and provenance durable"
  );
  const human = await syncReplica(two),
    hv = Y.encodeStateVector(human);
  human
    .getMap("slides")
    .get("s1")
    .get("elements")
    .get("s1e1")
    .get("props")
    .set("y", "80");
  two.ws.send(update(Y.encodeStateAsUpdate(human, hv)));
  await pause(60);
  await call("/revert", { id: "guarded" });
  const undone = await call("/deck-read");
  check(
    undone.slides.find((v) => v.id === "s1").html.includes('prop-x="20"') &&
      undone.slides.find((v) => v.id === "s1").html.includes('prop-y="80"'),
    "scoped deck revert removes agent edits and preserves later human property"
  );
  human.destroy();
  const compactRead = await call("/deck-read");
  const large = await syncReplica(two),
    lv = Y.encodeStateVector(large);
  large
    .getMap("slides")
    .get("s1")
    .get("notes")
    .insert(0, "n".repeat(1_050_000));
  two.ws.send(update(Y.encodeStateAsUpdate(large, lv)));
  await pause(180);
  check(
    (await call("/stats")).meta.generation > 1,
    "room compacts actual large accepted delta"
  );
  const compactSlide = compactRead.slides.find((v) => v.id === "s2");
  const compactWrite = await call("/deck-write", {
    changeId: "after-compaction",
    ops: [
      {
        html: compactSlide.html.replace('duration="0"', 'duration="1"'),
        op: "write",
        revision: compactSlide.revision,
        slideId: "s2",
      },
    ],
  });
  check(
    compactWrite.applied.length === 1,
    "opaque observations remain usable across durable compaction"
  );
  large.destroy();
  const newest = await call("/deck-read");
  const invalid = await runtime.dispatchFetch(
    "http://room.test/deck-write?room=test",
    {
      body: JSON.stringify({
        ops: [
          { html: slide("s3", "a2"), op: "add" },
          {
            html: newest.slides[0].html.replace("<p>", "<script>"),
            op: "write",
            revision: newest.slides[0].revision,
            slideId: "s1",
          },
        ],
      }),
      method: "POST",
    }
  );
  check(!invalid.ok, "hostile batch refused atomically");
  check(
    !(await call("/deck-read")).deck.order.includes("s3"),
    "valid prefix of invalid tool batch never lands"
  );
  const presence = {
    pointer: { x: 4, y: 9 },
    selection: ["s1e1"],
    slideId: "s1",
    user: { id: "evil", name: "Impersonated" },
  };
  one.ws.send(awareness(900, 999, presence));
  await pause(80);
  const seen = presences(one).findLast((p) => p.state?.slideId === "s1");
  check(
    seen.id === hello.awarenessId &&
      seen.state.user.id === "owner" &&
      seen.state.user.name === "Trusted owner",
    "deck awareness echo uses trusted server identity"
  );
  const control = (client, action, fields = {}) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        client.ws.removeEventListener("message", receive);
      };
      const receive = (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const result = JSON.parse(event.data);
        if (
          result.type !== "presentation-result" ||
          result.requestId !== requestId
        ) {
          return;
        }
        cleanup();
        resolve(result);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Presenter ${action} request ${requestId} timed out`));
      }, 5000);
      client.ws.addEventListener("message", receive);
      client.ws.send(
        JSON.stringify({ action, requestId, type: "presentation", ...fields })
      );
    });
  const [lease, race] = await Promise.all([
    control(one, "acquire", { build: 0, slideId: "s1" }),
    control(two, "acquire", { build: 0, slideId: "s2" }),
  ]);
  check(lease.ok !== race.ok, "only one concurrent presenter lease wins");
  const ownerId = lease.ok ? "owner" : "editor";
  const owner = lease.ok ? one : two,
    other = lease.ok ? two : one,
    winner = lease.ok ? lease : race;
  check(
    !(
      await control(other, "position", {
        build: 1,
        leaseId: winner.leaseId,
        slideId: "s2",
      })
    ).ok,
    "another connection cannot steal lease even knowing token"
  );
  check(
    (await control(owner, "renew", { leaseId: winner.leaseId })).ok,
    "owner can renew active lease"
  );
  check(
    (
      await control(owner, "position", {
        build: 2,
        leaseId: winner.leaseId,
        slideId: "s2",
      })
    ).ok,
    "owner broadcasts trusted position"
  );
  check(
    other.messages
      .filter((m) => typeof m === "string")
      .map(JSON.parse)
      .some(
        (m) =>
          m.type === "presentation" &&
          m.position?.slideId === "s2" &&
          m.position.build === 2
      ),
    "other client receives presenter position"
  );
  await controls(`role:${ownerId}`, "viewer");
  await call("/refresh");
  await pause(100);
  check(
    other.messages
      .filter((m) => typeof m === "string")
      .map(JSON.parse)
      .filter((m) => m.type === "presentation")
      .at(-1).position === null,
    "permission refresh clears trusted spotlight"
  );
  check(
    (await control(other, "acquire", { build: 0, slideId: "s1" })).ok,
    "downgrade releases presenter lease"
  );
  await controls(`role:${ownerId}`, "owner");
  await call("/refresh");
  const beforeBad = await call("/snapshot");
  const hostile = await connect(await ticket({ participantId: "hostile" }));
  const bad = await syncReplica(hostile);
  const badv = Y.encodeStateVector(bad);
  bad.getMap("meta").set("hacked", true);
  hostile.ws.send(update(Y.encodeStateAsUpdate(bad, badv)));
  await pause(100);
  check(hostile.closed, "hostile raw Yjs rejected and connection closed");
  check(
    (await call("/snapshot")).revision === beforeBad.revision,
    "hostile raw update changes no durable authority"
  );
  const oldRead = await call("/deck-read");
  await call("/checkpoint");
  one.ws.close();
  two.ws.close();
  await pause(100);
  await runtime.dispose();
  runtime = boot();
  const recovered = await call("/snapshot");
  check(
    recovered.revision === beforeBad.revision,
    "SQLite restart retains admitted revision"
  );
  await fails("/deck-write", {
    ops: [
      {
        html: oldRead.slides[0].html,
        op: "write",
        revision: oldRead.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  const restart = await connect(await ticket());
  const rr = await call("/deck-read");
  await call("/deck-restore", { requestId: "restore-1", state: snap.state });
  await fails("/deck-write", {
    ops: [
      {
        html: rr.slides[0].html,
        op: "write",
        revision: rr.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  check(
    (await call("/snapshot")).revision > recovered.revision,
    "restore is monotonic live change"
  );
  const saved = await call("/snapshot");
  await call("/deck-restore", { requestId: "restore-1", state: snap.state });
  check(
    (await call("/snapshot")).revision === saved.revision,
    "restore request idempotent"
  );
  await controls("role:owner", "viewer");
  await call("/refresh");
  const denied = await connect(await ticket({ role: "owner" }));
  check(denied.status === 403, "stale pre-downgrade ticket refused");
  await controls("role:owner", null);
  await call("/refresh");
  await pause(60);
  check(restart.closed, "revoked connection closed");
  const exp = await connect(await ticket({ participantId: "expires" }));
  await call("/expire");
  await call("/alarm");
  await pause(60);
  check(exp.closed, "connection expiry enforced by alarm");
  await controls("deck", true, "lease-expiry");
  await controls("slides", [slide("s1", "a0")], "lease-expiry");
  const ep1 = await connect(await ticket({}, "lease-expiry"), "lease-expiry"),
    ep2 = await connect(
      await ticket({ participantId: "second" }, "lease-expiry"),
      "lease-expiry"
    );
  const expiredLease = await control(ep1, "acquire", {
    build: 0,
    slideId: "s1",
  });
  check(expiredLease.ok, "expiry fixture acquires real lease");
  await pause(15_100);
  check(
    !(await control(ep1, "renew", { leaseId: expiredLease.leaseId })).ok,
    "expired lease cannot be renewed"
  );
  const replacement = await control(ep2, "acquire", {
    build: 0,
    slideId: "s1",
  });
  check(replacement.ok, "lease expiry frees ownership for another client");
  ep2.ws.close();
  await pause(80);
  check(
    (await control(ep1, "acquire", { build: 0, slideId: "s1" })).ok,
    "disconnect releases presenter without waiting for expiry"
  );
  ep1.ws.close();
  a.destroy();
  b.destroy();
  current.destroy();
  combined.destroy();
  bad.destroy();
  process.stdout.write(JSON.stringify({ passed }));
} catch (error) {
  process.stdout.write(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
  await rm(directory, { force: true, recursive: true });
}
