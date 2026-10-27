// biome-ignore-all lint/performance/noNamespaceImport: protocol libraries expose namespaced APIs.
// biome-ignore-all lint/suspicious/noEvolvingTypes: the update event populates this fixture array.
import { DurableObject } from "cloudflare:workers";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirror,
} from "@tiptap/y-tiptap";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { routePartykitRequest } from "partyserver";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  schema,
} from "prosemirror-markdown";
import { YServer } from "y-partyserver";
import * as awareness from "y-protocols/awareness";
import * as Y from "yjs";

export class Room extends DurableObject {
  run() {
    const input = "# Heading\n\nHello **world**.";
    const pm = defaultMarkdownParser.parse(input);
    const doc = prosemirrorJSONToYDoc(schema, pm.toJSON(), "content");
    const roundtrip = defaultMarkdownSerializer.serialize(
      yXmlFragmentToProsemirror(schema, doc.getXmlFragment("content"))
    );
    const manager = new MarkdownManager({ extensions: [StarterKit] });
    const tiptapJson = manager.parse(input);
    const tiptapDoc = prosemirrorJSONToYDoc(
      getSchema([StarterKit]),
      tiptapJson,
      "content"
    );
    const tiptapRoundtrip = manager.serialize(
      yXmlFragmentToProsemirror(
        getSchema([StarterKit]),
        tiptapDoc.getXmlFragment("content")
      ).toJSON()
    );
    const a = new Y.Doc();
    a.getText("text").insert(0, "hello world");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const relative = Y.createRelativePositionFromTypeIndex(
      a.getText("text"),
      6
    );
    b.getText("text").insert(6, "human ");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const pos = Y.createAbsolutePositionFromRelativePosition(relative, a);
    a.getText("text").insert(pos.index, "agent ");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, data BLOB NOT NULL)"
    );
    sql.exec("DELETE FROM chunks");
    const large = new Y.Doc();
    large.getText("body").insert(0, "x".repeat(5 * 1024 * 1024));
    const snapshot = Y.encodeStateAsUpdate(large);
    const chunkSize = 128 * 1024;
    for (let i = 0; i < snapshot.length; i += chunkSize) {
      sql.exec(
        "INSERT INTO chunks VALUES (?, ?)",
        i / chunkSize,
        snapshot.slice(i, i + chunkSize)
      );
    }
    const updateDoc = new Y.Doc();
    Y.applyUpdate(updateDoc, snapshot);
    const updates = [];
    updateDoc.on("update", (u) => updates.push(u));
    updateDoc.getText("body").insert(0, "tail");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, data BLOB NOT NULL)"
    );
    sql.exec("DELETE FROM updates");
    for (const [i, update] of updates.entries()) {
      sql.exec("INSERT INTO updates VALUES (?, ?)", i, update);
    }
    const rows = sql.exec("SELECT data FROM chunks ORDER BY id").toArray();
    const bytes = new Uint8Array(snapshot.length);
    let offset = 0;
    for (const row of rows) {
      const chunk = new Uint8Array(row.data);
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const restored = new Y.Doc();
    Y.applyUpdate(restored, bytes);
    for (const row of sql
      .exec("SELECT data FROM updates ORDER BY id")
      .toArray()) {
      Y.applyUpdate(restored, new Uint8Array(row.data));
    }
    return {
      chunks: rows.length,
      concurrent: [a.getText("text").toString(), b.getText("text").toString()],
      dom: typeof document,
      restoredBytes: restored.getText("body").length,
      roundtrip,
      snapshotBytes: snapshot.length,
      tiptapRoundtrip,
      updates: updates.length,
    };
  }
}
// This key and issuer are deliberately public fixture-only credentials. Never deploy.
const key = "local-spike-only-not-a-production-secret";
const bytes = new TextEncoder();
async function signature(payload) {
  const k = await crypto.subtle.importKey(
    "raw",
    bytes.encode(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, bytes.encode(payload))
  );
}
const base64 = (value) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function issue(claims) {
  const payload = base64(bytes.encode(JSON.stringify(claims)));
  return `${payload}.${base64(await signature(payload))}`;
}
async function verify(ticket, artifact) {
  try {
    const [payload, mac, extra] = ticket.split(".");
    if (!(payload && mac) || extra) {
      return null;
    }
    const k = await crypto.subtle.importKey(
      "raw",
      bytes.encode(key),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"]
    );
    const supplied = Uint8Array.from(
      atob(mac.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0)
    );
    if (
      !(await crypto.subtle.verify("HMAC", k, supplied, bytes.encode(payload)))
    ) {
      return null;
    }
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0)
        )
      )
    );
    if (
      claims.artifact !== artifact ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Date.now() ||
      !claims.jti ||
      !Number.isSafeInteger(claims.clientId) ||
      claims.clientId < 0 ||
      !["edit", "read"].includes(claims.role) ||
      !claims.participant ||
      !claims.name ||
      !claims.kind ||
      !claims.color
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
export class Live extends YServer {
  static options = { hibernate: true };
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS used (ticket TEXT PRIMARY KEY)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS starts (n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO starts VALUES (1)");
  }
  consume(claims) {
    if (this.document.awareness.getStates().has(claims.clientId)) {
      return false;
    }
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO owners VALUES (?, ?)",
          claims.clientId,
          claims.jti
        );
        this.ctx.storage.sql.exec("INSERT INTO used VALUES (?)", claims.jti);
      });
      return true;
    } catch {
      return false;
    }
  }
  stats() {
    return {
      sockets: this.ctx.getWebSockets().length,
      starts: this.ctx.storage.sql
        .exec("SELECT count(*) AS n FROM starts")
        .one().n,
    };
  }
  revoke(id) {
    let count = 0;
    for (const c of this.getConnections()) {
      if (c.state?.participant === id) {
        c.close(4001, "revoked");
        count += 1;
      }
    }
    return count;
  }
  async onConnect(conn, ctx) {
    const url = new URL(ctx.request.url);
    const claims = await verify(
      url.searchParams.get("ticket") || "",
      url.pathname.split("/").at(-1)
    );
    if (!claims) {
      conn.close(4003, "invalid");
      return;
    }
    conn.setState(claims);
    super.onConnect(conn, ctx);
  }
  isReadOnly(conn) {
    return conn.state?.role !== "edit";
  }
  onMessage(conn, message) {
    if (typeof message === "string") {
      return super.onMessage(conn, message);
    }
    try {
      const raw = new Uint8Array(message);
      const outer = decoding.createDecoder(raw);
      if (decoding.readVarUint(outer) !== 1) {
        return super.onMessage(conn, message);
      }
      if (raw.length > 4096) {
        return;
      }
      const input = decoding.createDecoder(decoding.readVarUint8Array(outer));
      if (decoding.readVarUint(input) !== 1) {
        return;
      }
      const id = decoding.readVarUint(input);
      const clock = decoding.readVarUint(input);
      const state = JSON.parse(decoding.readVarString(input));
      if (
        id !== conn.state?.clientId ||
        decoding.hasContent(input) ||
        decoding.hasContent(outer)
      ) {
        return;
      }
      // Only a bounded cursor survives; identity is always supplied by the ticket.
      const sanitized =
        state === null
          ? null
          : {
              user: {
                color: conn.state.color,
                id: conn.state.participant,
                kind: conn.state.kind,
                name: conn.state.name,
              },
              ...(typeof state.cursor === "number" &&
              Number.isSafeInteger(state.cursor) &&
              state.cursor >= 0
                ? { cursor: state.cursor }
                : {}),
            };
      const update = encoding.createEncoder();
      encoding.writeVarUint(update, 1);
      encoding.writeVarUint(update, id);
      encoding.writeVarUint(update, clock);
      encoding.writeVarString(update, JSON.stringify(sanitized));
      awareness.applyAwarenessUpdate(
        this.document.awareness,
        encoding.toUint8Array(update),
        null
      );
    } catch {
      /* Reject malformed input without relaying it. */
    }
  }
  onClose(conn) {
    if (conn.state) {
      this.ctx.storage.sql.exec(
        "DELETE FROM owners WHERE id = ? AND ticket = ?",
        conn.state.clientId,
        conn.state.jti
      );
      awareness.removeAwarenessStates(
        this.document.awareness,
        [conn.state.clientId],
        null
      );
    }
  }
  insertAgent(encoded) {
    this.document.getText("test");
    const relative = Y.decodeRelativePosition(Uint8Array.from(encoded));
    const position = Y.createAbsolutePositionFromRelativePosition(
      relative,
      this.document
    );
    if (!position || position.type !== this.document.getText("test")) {
      throw new Error("missing target");
    }
    position.type.insert(position.index, "agent ");
  }
  agent() {
    const d = new Y.Doc();
    while (
      this.ctx.storage.sql
        .exec("SELECT id FROM owners WHERE id = ?", d.clientID)
        .toArray().length
    ) {
      d.clientID = Math.floor(Math.random() * 0x1_00_00_00_00);
    }
    const a = new awareness.Awareness(d);
    a.setLocalState({ status: "Editing", user: { name: "Agent" } });
    awareness.applyAwarenessUpdate(
      this.document.awareness,
      awareness.encodeAwarenessUpdate(a, [d.clientID]),
      null
    );
    a.destroy();
    d.destroy();
  }
}
export default {
  async fetch(request, env) {
    if (env.LOCAL_FIXTURE_CAPABILITY !== "local-only") {
      return new Response("local fixture disabled", { status: 403 });
    }
    const url = new URL(request.url);
    const artifact = url.pathname.split("/").at(-1);
    const stub = env.LIVE.getByName(artifact || "test");
    if (url.pathname === "/ticket") {
      const claims = await request.json();
      return Response.json({
        ticket: await issue({ ...claims, jti: crypto.randomUUID() }),
      });
    }
    if (url.pathname === "/stats") {
      return Response.json(await env.LIVE.getByName("test").stats());
    }
    if (url.pathname === "/insert-agent") {
      await env.LIVE.getByName("test").insertAgent(await request.json());
      return new Response("ok");
    }
    if (url.pathname === "/agent") {
      await env.LIVE.getByName("test").agent();
      return new Response("ok");
    }
    if (url.pathname === "/revoke") {
      return Response.json(
        await env.LIVE.getByName("test").revoke(url.searchParams.get("id"))
      );
    }
    if (url.pathname.startsWith("/parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          onBeforeConnect: async (req) => {
            const claims = await verify(
              new URL(req.url).searchParams.get("ticket") || "",
              artifact
            );
            if (!(claims && (await stub.consume(claims)))) {
              return new Response("denied", { status: 403 });
            }
          },
        })) ?? new Response("missing", { status: 404 })
      );
    }
    return Response.json(await env.ROOM.getByName("test").run());
  },
};
