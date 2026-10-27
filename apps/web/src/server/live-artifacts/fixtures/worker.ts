// biome-ignore-all lint/suspicious/useAwait: fixture implements asynchronous service ports with synchronous SQLite.
// biome-ignore-all lint/performance/noNamespaceImport: Yjs fixture primitives.

import { LiveDocument, type Operation } from "@repo/live-doc";
import type { DeckReadInput, DeckWriteInput } from "@repo/mcp/tools/deck";
import { createDeckCheckpoint } from "@repo/mcp/tools/deck-scene";
import type {
  AwarenessEntry,
  LiveOperationOrigin,
  RoomTicketClaims,
} from "@repo/protocol/live";
import {
  signRoomTicket,
  verifyRoomTicket,
} from "@repo/services/live-artifacts/ticket";
import * as Y from "yjs";
import { ArtifactRoom } from "../artifact-room";
import { documentContent } from "../content";
import type {
  ArtifactRoomEnv,
  ArtifactRoomService,
  RoomIdentity,
  RoomSnapshot,
} from "../ports";
import { RoomStorage } from "../storage";
import { embedContentFetch } from "./embed-content";

const scope = {
  artifactId: "12345678-1234-4123-8123-123456789abc",
  workspaceId: "workerd",
};
// Public signing issuer exists only in this test entrypoint; never exported from production.
const key = "fixture-only-room-signing-key";
function initial(): RoomSnapshot {
  const live = new LiveDocument(new Y.Doc({ gc: false }));
  live.import({ markdown: "# Fixture\n\nHello human." }, "init");
  const snapshot = {
    revision: live.read().revision,
    state: Y.encodeStateAsUpdate(live.doc),
  };
  live.destroy();
  live.doc.destroy();
  return snapshot;
}
export class TestArtifactRoom extends ArtifactRoom {
  private readonly fixture: DurableObjectState;
  constructor(ctx: DurableObjectState, env: ArtifactRoomEnv) {
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture (key TEXT PRIMARY KEY,value TEXT)"
    );
    const get = <T>(name: string): T | undefined => {
      const [row] = ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM fixture WHERE key=?", name)
        .toArray();
      return row ? (JSON.parse(row.value) as T) : undefined;
    };
    const put = (name: string, value: unknown) =>
      ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO fixture VALUES (?,?)",
        name,
        JSON.stringify(value)
      );
    const service: ArtifactRoomService = {
      admit: async (roomScope, token) => {
        const claims = await verifyRoomTicket(token, key, {
          ...roomScope,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        return claims ? service.authorize(roomScope, claims) : null;
      },
      authorize: async (_scope, subject) => {
        put("authCalls", (get<number>("authCalls") ?? 0) + 1);
        if (get<boolean>("deleted")) {
          return null;
        }
        const role = get<RoomIdentity["role"] | null>(
          `role:${subject.participantId}`
        );
        if (role === null) {
          return null;
        }
        return {
          ...subject,
          authorizationRef: `fixture:${subject.participantId}`,
          color: "#123456",
          forceSuggestions:
            get<boolean>(`force:${subject.participantId}`) ?? false,
          name: `Trusted ${subject.participantId}`,
          role: role ?? (subject.kind === "agent" ? "editor" : "owner"),
        };
      },
      open: async () =>
        get<boolean>("deck")
          ? {
              ...scope,
              kind: "deck",
              revision: 0,
              state: get<number[]>("checkpoint")
                ? Uint8Array.from(get<number[]>("checkpoint") ?? [])
                : createDeckCheckpoint(
                    {
                      slides: get<string[]>("slides") ?? [],
                      title: "Fixture deck",
                    },
                    (path) =>
                      (
                        get<string[]>("urls") ?? ["/files/own-image.png"]
                      ).includes(path)
                  ),
            }
          : { ...scope, ...initial() },
      ownBlobUrls: async () =>
        get<string[]>("urls") ?? ["/files/own-image.png"],
      prepareCheckpoint: async () =>
        get<string>("publicationActor") ?? "initial-actor",
      protectedRanges: async () =>
        get<
          Array<{
            start: import("@repo/protocol/live").RelativePositionJSON;
            end: import("@repo/protocol/live").RelativePositionJSON;
          }>
        >("ranges") ?? [],
      save: async (_scope, input) => {
        put("saveCalls", (get<number>("saveCalls") ?? 0) + 1);
        if (get<boolean>("failSave")) {
          throw new Error("DB save failure");
        }
        const prior = get<{ versionId: string; revision: number }>(
          `saved:${input.checkpointId}`
        );
        if (prior) {
          return prior;
        }
        const result = {
          revision: input.revision,
          versionId: crypto.randomUUID(),
        };
        put(`saved:${input.checkpointId}`, result);
        put("saved", { ...input, state: input.state.length });
        put("checkpoint-state", [...input.state]);
        if (get<boolean>("failAfterSave")) {
          put("failAfterSave", false);
          throw new Error("Acknowledgement lost");
        }
        return result;
      },
    };
    super(ctx, {
      ...env,
      ARTIFACT_ROOM_SERVICE: service,
      ARTIFACT_ROOM_TICKET_KEY: key,
    });
    this.fixture = ctx;
    put("starts", (get<number>("starts") ?? 0) + 1);
  }
  fixtureValue(name: string): unknown {
    const [row] = this.fixture.storage.sql
      .exec<{ value: string }>("SELECT value FROM fixture WHERE key=?", name)
      .toArray();
    return row ? JSON.parse(row.value) : null;
  }
  storeImage(path: string, bytes: number[]) {
    this.control(`image:${path}`, bytes);
    const urls = (this.fixtureValue("urls") ?? []) as string[];
    this.control("urls", [...new Set([...urls, path])]);
    return { alt: "Captured image", url: path };
  }
  async checkpointMarkdown() {
    const state = this.fixtureValue("checkpoint-state") as number[] | null;
    if (!state) {
      throw new Error("No persisted checkpoint");
    }
    return documentContent(
      new Set((this.fixtureValue("urls") ?? []) as string[])
    ).exportDocument({ revision: 0, state: Uint8Array.from(state) });
  }
  triggerAlarm() {
    return this.alarm();
  }
  control(name: string, value: unknown) {
    this.fixture.storage.sql.exec(
      "INSERT OR REPLACE INTO fixture VALUES (?,?)",
      name,
      JSON.stringify(value)
    );
  }
  ticket(input: Partial<RoomTicketClaims> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signRoomTicket(
      {
        ...scope,
        audience: "artifact-room",
        color: "#abcdef",
        connectionExpiresAt: now + 900,
        expiresAt: now + 120,
        issuedAt: now,
        jti: crypto.randomUUID(),
        kind: "member",
        name: "Untrusted old ticket name",
        participantId: "owner",
        role: "owner",
        version: 1,
        ...input,
      },
      key
    );
  }
  stats() {
    const { sql } = this.fixture.storage;
    return {
      chunks: sql
        .exec<{ kind: string; n: number; max: number }>(
          "SELECT kind,count(*) AS n,max(length(data)) AS max FROM room_chunks GROUP BY kind"
        )
        .toArray(),
      fixture: Object.fromEntries(
        sql
          .exec<{ key: string; value: string }>("SELECT * FROM fixture")
          .toArray()
          .map((row) => [row.key, JSON.parse(row.value)])
      ),
      meta: new RoomStorage(this.fixture.storage).get("state"),
      pending: new RoomStorage(this.fixture.storage).get("pending"),
      socketStates: this.fixture.getWebSockets().map((s) => ({
        ready: s.readyState,
        state: s.deserializeAttachment(),
      })),
      sockets: this.fixture
        .getWebSockets()
        .filter(
          (s) =>
            (s.deserializeAttachment() as { expires: number }).expires >
            Date.now()
        ).length,
    };
  }
  expire() {
    for (const socket of this.fixture.getWebSockets()) {
      const state = socket.deserializeAttachment() as { expires: number };
      state.expires = Date.now() - 1;
      socket.serializeAttachment(state);
    }
  }
  seed(markdown: string) {
    const live = new LiveDocument(new Y.Doc());
    live.import({ markdown }, "fixture");
    const snapshot = {
      revision: live.read().revision,
      state: Y.encodeStateAsUpdate(live.doc),
    };
    live.destroy();
    live.doc.destroy();
    return this.restore({
      byParticipant: "owner",
      requestId: crypto.randomUUID(),
      snapshot,
      versionId: "seed",
    });
  }
  async protectWord(word: string) {
    await this.read();
    const store = new RoomStorage(this.fixture.storage);
    const meta = store.get<{
      generation: number;
      sequence: number;
      baseSequence: number;
      revision: number;
    }>("state");
    if (!meta) {
      throw new Error("Uninitialized");
    }
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, store.read("snapshot", String(meta.generation)));
    for (let i = meta.baseSequence + 1; i <= meta.sequence; i += 1) {
      Y.applyUpdate(doc, store.read("update", String(i)));
    }
    const live = new LiveDocument(doc, { revision: meta.revision });
    const block = live.read().blocks.find((b) => b.text.includes(word));
    if (!block) {
      throw new Error("Word not found");
    }
    const anchor = live.anchor(
      block.id,
      block.text.indexOf(word),
      block.text.indexOf(word) + word.length
    );
    live.destroy();
    doc.destroy();
    this.control("ranges", [anchor]);
    return JSON.parse(
      JSON.stringify(anchor)
    ) as import("@repo/protocol/live").CommentAnchor;
  }
  makeCheckpointDue() {
    const store = new RoomStorage(this.fixture.storage);
    const meta = store.get<Record<string, unknown>>("state");
    if (!meta) {
      throw new Error("Uninitialized");
    }
    store.put("state", { ...meta, dirtySince: Date.now() - 300_001 });
  }
  /** Roll back a half-written generation in real DO SQLite. */
  interruptedGeneration() {
    const store = new RoomStorage(this.fixture.storage);
    try {
      this.fixture.storage.transactionSync(() => {
        store.write("snapshot", "uncommitted", new Uint8Array(700_000));
        store.put("state", { generation: "uncommitted" });
        throw new Error("crash before generation switch");
      });
    } catch {
      /* simulate interrupted compaction */
    }
    return store.get("state");
  }
}
interface FixtureEnv {
  ROOM: DurableObjectNamespace<TestArtifactRoom>;
}
/** Explicit captured image leaf: stored SQLite bytes and ownership precede acknowledgement.
 * Production fetch/R2 authorization is exercised separately by production.test.ts. */
async function fixtureImage(request: Request, env: FixtureEnv, url: URL) {
  if (url.pathname.startsWith("/files/")) {
    const [, , room] = url.pathname.split("/");
    const bytes = (await env.ROOM.getByName(room ?? "test").fixtureValue(
      `image:${url.pathname}`
    )) as number[] | null;
    return bytes
      ? new Response(Uint8Array.from(bytes), {
          headers: { "Content-Type": "image/png" },
        })
      : new Response("Missing", { status: 404 });
  }
  const stub = env.ROOM.getByName(url.searchParams.get("room") ?? "test");
  if (url.pathname === "/fixture-image") {
    const path = `/files/${url.searchParams.get("room")}/${crypto.randomUUID()}`;
    let bytes: Uint8Array;
    if (request.headers.get("Content-Type") === "application/json") {
      const input = (await request.json()) as { url: string };
      if (input.url !== "https://public-images.example.com/captured.png") {
        return new Response("Uncaptured image refused", { status: 400 });
      }
      bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        ),
        (c) => c.charCodeAt(0)
      );
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
    }
    return Response.json(await stub.storeImage(path, [...bytes]));
  }
  return null;
}
const fixtureRoomName = (url: URL) => url.searchParams.get("room") ?? "test";
export default {
  async fetch(request: Request, env: FixtureEnv) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/a/") || url.pathname === "/embed-url") {
      return embedContentFetch(request);
    }
    const imageResponse = await fixtureImage(request, env, url);
    if (imageResponse) {
      return imageResponse;
    }
    const stub = env.ROOM.getByName(fixtureRoomName(url));
    if (request.headers.get("Upgrade")) {
      return stub.fetch(request);
    }
    const input =
      request.method === "POST"
        ? ((await request.json()) as Record<string, unknown>)
        : {};
    try {
      let result: unknown;
      switch (url.pathname) {
        case "/suggestions":
          result = await stub.listSuggestions({
            kind:
              (input.kind as "member" | "guest" | "agent" | undefined) ??
              "member",
            participantId:
              (input.participantId as string | undefined) ?? "owner",
          });
          break;
        case "/suggestion-mode":
          result = await stub.setSuggestionMode(input.enabled === true, {
            kind: "member",
            participantId:
              (input.participantId as string | undefined) ?? "owner",
          });
          result = await stub.listSuggestions({
            kind: "member",
            participantId: "owner",
          });
          break;
        case "/suggestion-decision":
          await stub.decideSuggestion(
            {
              decision: input.decision as "accept" | "reject",
              suggestionId: input.suggestionId as string,
            },
            {
              kind:
                (input.kind as "member" | "guest" | "agent" | undefined) ??
                "member",
              participantId:
                (input.participantId as string | undefined) ?? "owner",
            }
          );
          result = await stub.listSuggestions({
            kind: "member",
            participantId: "owner",
          });
          break;
        case "/checkpoint-markdown":
          result = await stub.checkpointMarkdown();
          break;
        case "/snapshot": {
          const snapshot = await stub.authoritativeSnapshot();
          result = { revision: snapshot.revision, state: [...snapshot.state] };
          break;
        }
        case "/ensure-deck-cell":
        case "/ensure-cell": {
          const snapshot = await stub.ensureDeckCell(
            {
              elementId: input.elementId as string,
              key: input.key as string,
              slideId: input.slideId as string,
            },
            {
              kind: "member",
              participantId:
                typeof input.participantId === "string"
                  ? input.participantId
                  : "owner",
            }
          );
          result = { revision: snapshot.revision, state: [...snapshot.state] };
          break;
        }
        case "/deck-read":
          result = await stub.deckRead(
            { artifactId: scope.artifactId, ...input } as DeckReadInput,
            { kind: "agent", participantId: "agent" }
          );
          break;
        case "/deck-write":
          result = await stub.deckWrite(
            { artifactId: scope.artifactId, ops: input.ops } as DeckWriteInput,
            {
              changeId:
                (input.changeId as string | undefined) ?? crypto.randomUUID(),
              mode: input.mode === "suggestion" ? "suggestion" : "direct",
              participantId: "agent",
              runId: "run",
              toolCallId: "call",
            }
          );
          break;
        case "/deck-restore":
          result = await stub.restore({
            byParticipant: "owner",
            requestId:
              (input.requestId as string | undefined) ?? crypto.randomUUID(),
            snapshot: {
              revision: 0,
              state: Uint8Array.from(input.state as number[]),
            },
            versionId: "fixture",
          });
          break;
        case "/ticket":
          result = await stub.ticket(input);
          break;
        case "/read":
          result = await stub.read("markdown");
          break;
        case "/outline":
          result = await stub.read();
          break;
        case "/stats":
          result = await stub.stats();
          break;
        case "/control":
          result = await stub.control(input.name as string, input.value);
          break;
        case "/refresh":
          result = await stub.refresh(input.id as string | undefined);
          break;
        case "/agent":
          result = await stub.setAgentPresence(
            input.entry as AwarenessEntry | null
          );
          break;
        case "/anchor":
          result = await stub.protectWord(input.word as string);
          break;
        case "/resolve-anchor":
          result = await stub.resolveAnchor(
            input.anchor as import("@repo/protocol/live").CommentAnchor
          );
          break;
        case "/guard-snapshot":
          result = await stub.guardAgentSnapshot({
            runId: "run",
            snapshot: initial(),
          });
          break;
        case "/checkpoint-due":
          result = await stub.makeCheckpointDue();
          break;
        case "/presence":
          result = await stub.presence();
          break;
        case "/ops":
          result = await stub.applyAgentOps(
            input.ops as Operation[],
            input.origin as LiveOperationOrigin
          );
          break;
        case "/revert":
          result = await stub.revert(
            input.id as string,
            (input.byParticipant as string | undefined) ?? "owner"
          );
          break;
        case "/restore":
          result = await stub.restore({
            ...input,
            snapshot: initial(),
          } as Parameters<TestArtifactRoom["restore"]>[0]);
          break;
        case "/seed":
          result = await stub.seed(input.markdown as string);
          break;
        case "/checkpoint":
          result = await stub.checkpoint();
          break;
        case "/alarm":
          result = await stub.triggerAlarm();
          break;
        case "/expire":
          result = await stub.expire();
          break;
        case "/interrupt":
          result = await stub.interruptedGeneration();
          break;
        default:
          return new Response("missing", { status: 404 });
      }
      return Response.json(result ?? null);
    } catch (error) {
      return new Response(String(error), { status: 400 });
    }
  },
};
