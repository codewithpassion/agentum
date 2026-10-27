// biome-ignore-all lint/performance/noNamespaceImport: lib0 and Yjs expose protocol primitives.
import { DurableObject } from "cloudflare:workers";
import {
  type CapturedChange,
  DocumentError,
  LiveDocument,
  type Operation,
} from "@repo/live-doc";
import {
  type AwarenessEntry,
  awarenessEntrySchema,
  type CommentAnchor,
  type LiveOperationOrigin,
} from "@repo/protocol/live";
import { verifyRoomTicket } from "@repo/services/live-artifacts/ticket";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { guardAnchoredWords, resolveDocumentAnchor } from "./anchors";
import type {
  ArtifactRoomEnv,
  RestoreProvenance,
  RoomIdentity,
  RoomScope,
  RoomSnapshot,
} from "./ports";
import {
  COMPACT_BYTES,
  COMPACT_UPDATES,
  MAX_DOCUMENT_BYTES,
  RoomStorage,
} from "./storage";

const CHECKPOINT_MS = 5 * 60 * 1000;
const RETRY_MS = 5000;
const AGENT_MS = 5000;
interface Session extends RoomIdentity {
  awarenessId: number;
  clock: number;
  expires: number;
  present: AwarenessEntry | null;
}
interface Metadata {
  baseSequence: number;
  blockRevisions: Record<string, number>;
  dirtySince: number | null;
  generation: number;
  nextAwarenessId: number;
  origins: LiveOperationOrigin[];
  ownBlobUrls: string[];
  restores: RestoreProvenance[];
  revision: number;
  scope: RoomScope;
  sequence: number;
  updateBytes: number;
}
interface PendingSave {
  checkpointId: string;
  origins: LiveOperationOrigin[];
  restores: RestoreProvenance[];
  revision: number;
}
interface ChangeRecord {
  origin: LiveOperationOrigin;
  reverted?: { revision: number; byParticipant: string };
  revision: number;
}
interface AgentState {
  awarenessId: number;
  clock: number;
  entry: AwarenessEntry;
  expires: number;
}
const writable = (identity: RoomIdentity) =>
  identity.role === "editor" || identity.role === "owner";
const session = (socket: WebSocket): Session =>
  socket.deserializeAttachment() as Session;
function syncFrame(kind: number, bytes: Uint8Array) {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 0);
  encoding.writeVarUint(out, kind);
  encoding.writeVarUint8Array(out, bytes);
  return encoding.toUint8Array(out);
}
function presenceFrame(
  id: number,
  clock: number,
  entry: AwarenessEntry | null
) {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, id);
  encoding.writeVarUint(update, clock);
  const { id: participantId, name, kind, color, ...fields } = entry ?? {};
  encoding.writeVarString(
    update,
    JSON.stringify(
      entry
        ? { ...fields, user: { color, id: participantId, kind, name } }
        : null
    )
  );
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 1);
  encoding.writeVarUint8Array(out, encoding.toUint8Array(update));
  return encoding.toUint8Array(out);
}

/** Native hibernation + Yjs sync protocol fallback. No stock handler can apply an unvalidated update. */
export class ArtifactRoom extends DurableObject<ArtifactRoomEnv> {
  private readonly store: RoomStorage;
  private meta!: Metadata;
  private live!: LiveDocument;
  private policy = new Set<string>();
  private initialization: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ArtifactRoomEnv) {
    super(ctx, env);
    this.store = new RoomStorage(ctx.storage);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.ensureInitialized();
      return fn();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async ensureInitialized() {
    this.initialization ??= this.initialize();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }
  private async initialize() {
    const saved = this.store.get<Metadata>("state");
    if (saved) {
      this.meta = saved;
      this.policy = new Set(saved.ownBlobUrls);
      this.recover();
    } else {
      const initial = await this.env.ARTIFACT_ROOM_SERVICE.open(
        this.ctx.id.toString()
      );
      this.policy = new Set(
        await this.env.ARTIFACT_ROOM_SERVICE.ownBlobUrls(initial)
      );
      if (initial.state.length > MAX_DOCUMENT_BYTES) {
        throw new Error("Document exceeds 8 MiB");
      }
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, initial.state);
      this.live = new LiveDocument(doc, {
        ownBlobUrls: this.policy,
        revision: initial.revision,
      });
      this.meta = {
        baseSequence: 0,
        blockRevisions: Object.fromEntries(
          this.live.read().blocks.map((b) => [b.id, b.revision])
        ),
        dirtySince: null,
        generation: 1,
        nextAwarenessId: 1,
        origins: [],
        ownBlobUrls: [...this.policy],
        restores: [],
        revision: initial.revision,
        scope: {
          artifactId: initial.artifactId,
          workspaceId: initial.workspaceId,
        },
        sequence: 0,
        updateBytes: 0,
      };
      this.ctx.storage.transactionSync(() => {
        this.store.write("snapshot", "1", initial.state);
        this.store.put("state", this.meta);
      });
    }
  }
  private async refreshPolicy() {
    const urls = await this.env.ARTIFACT_ROOM_SERVICE.ownBlobUrls(
      this.meta.scope
    );
    this.policy = new Set(urls);
    this.live.options.ownBlobUrls = this.policy;
    this.meta.ownBlobUrls = urls;
    this.store.put("state", this.meta);
  }
  private recover() {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(
      doc,
      this.store.read("snapshot", String(this.meta.generation))
    );
    for (let i = this.meta.baseSequence + 1; i <= this.meta.sequence; i += 1) {
      Y.applyUpdate(doc, this.store.read("update", String(i)));
    }
    this.live?.destroy();
    this.live?.doc.destroy();
    this.live = new LiveDocument(doc, {
      ownBlobUrls: this.policy,
      revision: this.meta.revision,
    });
  }
  private snapshot(): RoomSnapshot {
    return {
      revision: this.meta.revision,
      state: Y.encodeStateAsUpdate(this.live.doc),
    };
  }
  private broadcast(bytes: Uint8Array, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except && session(socket).expires > Date.now()) {
        try {
          socket.send(bytes);
        } catch {
          /* close event owns cleanup */
        }
      }
    }
  }
  private nextId() {
    if (!Number.isSafeInteger(this.meta.nextAwarenessId + 1)) {
      throw new Error("Presence ID exhausted");
    }
    const id = this.meta.nextAwarenessId;
    this.meta.nextAwarenessId += 1;
    this.store.put("state", this.meta);
    return id;
  }
  private async authorize(
    subject: Pick<RoomIdentity, "participantId" | "kind">
  ) {
    const current = await this.env.ARTIFACT_ROOM_SERVICE.authorize(
      this.meta.scope,
      subject
    );
    if (
      !current ||
      current.participantId !== subject.participantId ||
      current.kind !== subject.kind
    ) {
      throw new Error("Access denied");
    }
    return current;
  }
  private async writer(subject: Pick<RoomIdentity, "participantId" | "kind">) {
    const current = await this.authorize(subject);
    if (!writable(current)) {
      throw new Error("Read only");
    }
    return current;
  }
  private async schedule() {
    const times: number[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const { expires } = session(socket);
      if (expires > 0) {
        times.push(expires);
      }
    }
    const agent = this.store.get<AgentState>("agent");
    if (agent) {
      times.push(agent.expires);
    }
    if (
      this.meta.dirtySince !== null &&
      !this.store.get<PendingSave>("pending")
    ) {
      times.push(this.meta.dirtySince + CHECKPOINT_MS);
    }
    if (this.store.get<PendingSave>("pending")) {
      times.push(Date.now() + RETRY_MS);
    }
    if (times.length) {
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 1, Math.min(...times))
      );
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
  private async admit(token: string, existing?: WebSocket) {
    if (token.length > 8192 || !this.env.ARTIFACT_ROOM_TICKET_KEY.trim()) {
      throw new Error("Invalid ticket");
    }
    const claims = await verifyRoomTicket(
      token,
      this.env.ARTIFACT_ROOM_TICKET_KEY,
      {
        ...this.meta.scope,
        nowSeconds: Math.floor(Date.now() / 1000),
      }
    );
    if (!claims) {
      throw new Error("Invalid ticket");
    }
    const current = await this.env.ARTIFACT_ROOM_SERVICE.admit(
      this.meta.scope,
      token
    );
    if (
      !current ||
      current.participantId !== claims.participantId ||
      current.kind !== claims.kind
    ) {
      throw new Error("Access denied");
    }
    // A pre-downgrade ticket must fail, even if it remains cryptographically valid.
    if (current.role !== claims.role) {
      throw new Error("Stale ticket role");
    }
    if (existing) {
      const old = session(existing);
      if (
        old.expires <= Date.now() ||
        old.participantId !== current.participantId ||
        old.kind !== current.kind
      ) {
        throw new Error("Invalid renewal");
      }
    }
    this.ctx.storage.transactionSync(() =>
      this.store.consume(
        claims.jti,
        claims.expiresAt,
        Math.floor(Date.now() / 1000)
      )
    );
    return {
      ...current,
      expires: Math.min(
        claims.connectionExpiresAt * 1000,
        Date.now() + 15 * 60 * 1000
      ),
    };
  }
  override fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket required", { status: 426 });
      }
      try {
        const identity = await this.admit(
          new URL(request.url).searchParams.get("ticket") ?? ""
        );
        // biome-ignore lint/correctness/noUndeclaredVariables: workerd global.
        const { 0: client, 1: server } = new WebSocketPair();
        const state: Session = {
          ...identity,
          awarenessId: this.nextId(),
          clock: 1,
          present: null,
        };
        server.serializeAttachment(state);
        this.ctx.acceptWebSocket(server);
        server.send(
          JSON.stringify({
            awarenessId: state.awarenessId,
            expiresAt: state.expires,
            type: "session",
          })
        );
        server.send(syncFrame(0, Y.encodeStateVector(this.live.doc)));
        for (const socket of this.ctx.getWebSockets()) {
          const other = session(socket);
          if (other.present && other.expires > Date.now()) {
            server.send(
              presenceFrame(other.awarenessId, other.clock, other.present)
            );
          }
        }
        const agent = this.store.get<AgentState>("agent");
        if (agent && agent.expires > Date.now()) {
          server.send(
            presenceFrame(agent.awarenessId, agent.clock, agent.entry)
          );
        }
        await this.schedule();
        return new Response(null, { status: 101, webSocket: client });
      } catch {
        return new Response("Access denied", { status: 403 });
      }
    });
  }
  private close(socket: WebSocket, reason: string) {
    const state = session(socket);
    if (state.expires === 0) {
      return;
    }
    state.expires = 0;
    state.clock += 1;
    state.present = null;
    socket.serializeAttachment(state);
    this.broadcast(presenceFrame(state.awarenessId, state.clock, null));
    socket.close(4001, reason);
  }
  override webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    return this.exclusive(async () => {
      try {
        let state = session(socket);
        if (state.expires <= Date.now()) {
          this.close(socket, "Expired");
          return;
        }
        // Also fail closed on messages while a durable refresh is being retried.
        const current = await this.authorize(state);
        state = { ...state, ...current };
        socket.serializeAttachment(state);
        if (typeof message === "string") {
          if (message.length > 8192) {
            throw new Error("Message too large");
          }
          const input = JSON.parse(message) as {
            type?: string;
            ticket?: string;
          };
          if (input.type !== "renew" || typeof input.ticket !== "string") {
            throw new Error("Invalid control");
          }
          const renewed = await this.admit(input.ticket, socket);
          socket.serializeAttachment({ ...state, ...renewed });
          socket.send(
            JSON.stringify({ expiresAt: renewed.expires, type: "renewed" })
          );
          await this.schedule();
          return;
        }
        if (message.byteLength > MAX_DOCUMENT_BYTES + 1024) {
          throw new Error("Message too large");
        }
        const decoder = decoding.createDecoder(new Uint8Array(message));
        const type = decoding.readVarUint(decoder);
        switch (type) {
          case 0:
            await this.receiveSync(socket, state, decoder);
            break;
          case 1:
            this.receivePresence(socket, state, decoder, message.byteLength);
            break;
          case 3:
            this.sendPresence(socket);
            break;
          default:
            throw new Error("Unsupported protocol");
        }
      } catch (error) {
        this.rejectMessage(socket, error);
      }
    });
  }
  private rejectMessage(socket: WebSocket, error: unknown) {
    try {
      socket.send(
        JSON.stringify({
          message: error instanceof DocumentError ? error.code : String(error),
          type: "error",
        })
      );
    } catch {
      /* socket may already be closed */
    }
    this.close(socket, "Rejected message");
  }
  private async receiveSync(
    socket: WebSocket,
    state: Session,
    decoder: decoding.Decoder
  ) {
    const kind = decoding.readVarUint(decoder);
    const bytes = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) {
      throw new Error("Trailing bytes");
    }
    if (kind === 0) {
      socket.send(syncFrame(1, Y.encodeStateAsUpdate(this.live.doc, bytes)));
    } else if (kind === 1 || kind === 2) {
      if (!writable(state)) {
        return; // Viewers still complete the normal Yjs read/sync handshake.
      }
      await this.mutate(
        (trial) =>
          trial.applyUpdate(bytes, {
            participantId: state.participantId,
          }),
        { agent: state.kind === "agent", participantId: state.participantId }
      );
    } else {
      throw new Error("Invalid sync type");
    }
  }
  private receivePresence(
    socket: WebSocket,
    state: Session,
    decoder: decoding.Decoder,
    byteLength: number
  ) {
    if (byteLength > 4096) {
      throw new Error("Presence too large");
    }
    const input = decoding.createDecoder(decoding.readVarUint8Array(decoder));
    if (decoding.hasContent(decoder) || decoding.readVarUint(input) !== 1) {
      throw new Error("Single presence required");
    }
    decoding.readVarUint(input); // Client ID is never authoritative or relayed.
    decoding.readVarUint(input); // Client clocks cannot poison server lifecycle clocks.
    const raw = JSON.parse(decoding.readVarString(input)) as Record<
      string,
      unknown
    > | null;
    if (decoding.hasContent(input)) {
      throw new Error("Trailing presence");
    }
    const identity = {
      color: state.color,
      id: state.participantId,
      kind: state.kind,
      name: state.name,
    };
    state.present =
      raw === null
        ? null
        : awarenessEntrySchema.parse({
            ...identity,
            cursor: raw.cursor,
            pointer: raw.pointer,
            selection: raw.selection,
            slideId: raw.slideId,
          });
    state.clock += 1;
    socket.serializeAttachment(state);
    this.broadcast(
      presenceFrame(state.awarenessId, state.clock, state.present)
    );
  }
  private sendPresence(socket: WebSocket) {
    for (const peer of this.ctx.getWebSockets()) {
      const other = session(peer);
      if (other.present && other.expires > Date.now()) {
        socket.send(
          presenceFrame(other.awarenessId, other.clock, other.present)
        );
      }
    }
  }
  override webSocketClose(socket: WebSocket): Promise<void> {
    return this.exclusive(async () => {
      this.close(socket, "Closed");
      if (
        !this.ctx
          .getWebSockets()
          .some((peer) => session(peer).expires > Date.now())
      ) {
        try {
          await this.saveCheckpoint();
        } catch {
          /* pending checkpoint is durable */
        }
      }
      await this.schedule();
    });
  }
  override webSocketError(socket: WebSocket): Promise<void> {
    return this.webSocketClose(socket);
  }

  /** Trial validates and computes a delta; persistence precedes authoritative application/broadcast. */
  private async mutate<T>(
    action: (trial: LiveDocument) => T,
    origin: object,
    persist?: (result: T, revision: number, full: Uint8Array) => void,
    guardComments = false
  ): Promise<T> {
    await this.refreshPolicy();
    const protect =
      guardComments ||
      "mode" in origin ||
      "revertChangeId" in origin ||
      ("agent" in origin && origin.agent === true);
    const ranges = protect
      ? await this.env.ARTIFACT_ROOM_SERVICE.protectedRanges(this.meta.scope)
      : [];
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.live.doc));
    const trial = new LiveDocument(doc, {
      ownBlobUrls: this.policy,
      protectedRanges: () => ranges,
      revision: this.meta.revision,
    });
    try {
      const vector = Y.encodeStateVector(doc);
      const result = action(trial);
      if (protect) {
        guardAnchoredWords(this.live, trial, ranges);
      }
      const full = Y.encodeStateAsUpdate(doc);
      if (full.length > MAX_DOCUMENT_BYTES) {
        throw new Error("Document exceeds 8 MiB");
      }
      const update = Y.encodeStateAsUpdate(doc, vector);
      const { revision } = trial.read();
      const previousBlocks = new Map(
        this.live.read().blocks.map((b) => [b.id, b])
      );
      const blockRevisions = Object.fromEntries(
        trial.read().blocks.map((b) => {
          const old = previousBlocks.get(b.id);
          const unchanged =
            old &&
            old.hash === b.hash &&
            old.index === b.index &&
            old.parentId === b.parentId;
          return [
            b.id,
            unchanged
              ? (this.meta.blockRevisions[b.id] ?? old.revision)
              : revision,
          ];
        })
      );
      const previous = structuredClone(this.meta);
      try {
        this.ctx.storage.transactionSync(() => {
          this.meta.sequence += 1;
          this.meta.revision = revision;
          this.meta.blockRevisions = blockRevisions;
          this.meta.updateBytes += update.length;
          this.meta.dirtySince ??= Date.now();
          this.store.write("update", String(this.meta.sequence), update);
          persist?.(result, revision, full);
          if (
            this.meta.sequence - this.meta.baseSequence >= COMPACT_UPDATES ||
            this.meta.updateBytes >= COMPACT_BYTES
          ) {
            const old = this.meta.generation;
            this.meta.generation += 1;
            this.store.write("snapshot", String(this.meta.generation), full);
            for (
              let i = this.meta.baseSequence + 1;
              i <= this.meta.sequence;
              i += 1
            ) {
              this.store.remove("update", String(i));
            }
            this.store.remove("snapshot", String(old));
            this.meta.baseSequence = this.meta.sequence;
            this.meta.updateBytes = 0;
          }
          this.store.put("state", this.meta);
        });
      } catch (error) {
        this.meta = previous;
        throw error;
      }
      // All inbound updates, including computed RPC deltas, use the engine's candidate validator.
      try {
        this.live.applyUpdate(update, origin);
      } catch (error) {
        this.recover();
        throw error;
      }
      this.broadcast(syncFrame(2, update));
      await this.schedule();
      return result;
    } finally {
      trial.destroy();
      doc.destroy();
    }
  }
  private outline() {
    const outline = this.live.read();
    return {
      ...outline,
      blocks: outline.blocks.map((b) => ({
        ...b,
        revision: this.meta.blockRevisions[b.id] ?? b.revision,
      })),
    };
  }
  /** Forks have a revision seed, while guards refer to persisted per-block room revisions.
   * Validate the real revision first, then translate only that guard into the disposable fork.
   * Hashes and ordered-batch validation remain the engine's responsibility.
   */
  private trialOperations(ops: Operation[], trial: LiveDocument): Operation[] {
    const blocks = new Map(this.outline().blocks.map((b) => [b.id, b]));
    const trialBlocks = new Map(trial.read().blocks.map((b) => [b.id, b]));
    return ops.map((op) => {
      let id: string | undefined;
      if ("target" in op && !("find" in op.target)) {
        id = op.target.blockId;
      } else if ("blockId" in op && "ifRev" in op) {
        id = op.blockId;
      }
      if (!(id && "ifRev" in op)) {
        return op;
      }
      const block = blocks.get(id);
      if (!block) {
        throw new DocumentError("block_gone");
      }
      if (op.ifRev !== block.revision) {
        throw new DocumentError("guard_mismatch", block);
      }
      return { ...op, ifRev: trialBlocks.get(id)?.revision };
    }) as Operation[];
  }
  resolveAnchor(anchor: CommentAnchor) {
    return this.exclusive(async () => resolveDocumentAnchor(this.live, anchor));
  }
  guardAgentSnapshot(input: { snapshot: RoomSnapshot; runId: string }) {
    return this.exclusive(async () => {
      if (input.snapshot.state.length > MAX_DOCUMENT_BYTES) {
        throw new Error("Document exceeds 8 MiB");
      }
      const ranges = await this.env.ARTIFACT_ROOM_SERVICE.protectedRanges(
        this.meta.scope
      );
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, input.snapshot.state);
      const candidate = new LiveDocument(doc, { ownBlobUrls: this.policy });
      try {
        guardAnchoredWords(this.live, candidate, ranges);
      } finally {
        candidate.destroy();
        doc.destroy();
      }
    });
  }
  read(view: "outline" | "markdown" = "outline") {
    return this.exclusive(async () => ({
      content: view === "markdown" ? this.live.markdown() : this.outline(),
      present: this.currentPresence(),
      revision: this.meta.revision,
    }));
  }
  applyAgentOps(ops: Operation[], origin: LiveOperationOrigin) {
    return this.exclusive(async () => {
      await this.writer({ kind: "agent", participantId: origin.participantId });
      const prior = this.store.get<ChangeRecord>(`change:${origin.changeId}`);
      if (prior) {
        if (JSON.stringify(prior.origin) !== JSON.stringify(origin)) {
          throw new Error("Change ID collision");
        }
        return { changeId: origin.changeId, revision: prior.revision };
      }
      const result = await this.mutate(
        (trial) => trial.capture(this.trialOperations(ops, trial), origin),
        origin,
        (captured, revision) => {
          this.store.write("before", origin.changeId, captured.change.before);
          this.store.write("change", origin.changeId, captured.change.update);
          this.store.put(`change:${origin.changeId}`, { origin, revision });
          this.meta.origins.push(origin);
        }
      );
      return { changeId: origin.changeId, revision: result.revision };
    });
  }
  revert(changeId: string, byParticipant: string) {
    return this.exclusive(async () => {
      await this.writer({ kind: "member", participantId: byParticipant });
      const record = this.store.get<ChangeRecord>(`change:${changeId}`);
      if (!record) {
        throw new Error("Unknown change");
      }
      if (record.reverted !== undefined) {
        return record.reverted;
      }
      const change: CapturedChange = {
        before: this.store.read("before", changeId),
        changeId,
        update: this.store.read("change", changeId),
      };
      const result = await this.mutate(
        (trial) => trial.revert(change, { participantId: byParticipant }),
        { participantId: byParticipant, revertChangeId: changeId },
        (_result, revision) => {
          this.store.put(`change:${changeId}`, {
            ...record,
            reverted: { byParticipant, revision },
          });
        }
      );
      return { ...result, byParticipant };
    });
  }
  restore(input: RestoreProvenance & { snapshot: RoomSnapshot }) {
    return this.exclusive(async () => {
      const current = await this.authorize({
        kind: "member",
        participantId: input.byParticipant,
      });
      if (current.role !== "owner") {
        throw new Error("Owner required");
      }
      if (input.snapshot.state.length > MAX_DOCUMENT_BYTES) {
        throw new Error("Document exceeds 8 MiB");
      }
      const key = `restore:${input.requestId}`;
      const prior = this.store.get<RestoreProvenance & { revision: number }>(
        key
      );
      if (prior) {
        if (
          prior.versionId !== input.versionId ||
          prior.byParticipant !== input.byParticipant
        ) {
          throw new Error("Restore ID collision");
        }
        return {
          revision: prior.revision,
          state: this.store.read("restore", input.requestId),
        };
      }
      const provenance: RestoreProvenance = {
        byParticipant: input.byParticipant,
        requestId: input.requestId,
        versionId: input.versionId,
      };
      await this.mutate(
        (trial) =>
          trial.restoreSnapshot(input.snapshot.state, {
            participantId: input.byParticipant,
          }),
        { participantId: input.byParticipant },
        (_result, revision, full) => {
          this.store.write("restore", input.requestId, full);
          this.store.put(key, { ...provenance, revision });
          // Capture exact restore result for idempotent service retries, even after later edits.
          this.meta.restores.push(provenance);
        }
      );
      return this.snapshot();
    });
  }
  private currentPresence(): AwarenessEntry[] {
    const entries = this.ctx
      .getWebSockets()
      .map((socket) => session(socket))
      .filter((s) => s.expires > Date.now() && s.present)
      .map((s) => s.present as AwarenessEntry);
    const agent = this.store.get<AgentState>("agent");
    if (agent && agent.expires > Date.now()) {
      entries.push(agent.entry);
    }
    return entries;
  }
  presence() {
    return this.exclusive(async () => this.currentPresence());
  }
  setAgentPresence(entry: AwarenessEntry | null) {
    return this.exclusive(async () => {
      const old = this.store.get<AgentState>("agent");
      if (!entry) {
        if (old) {
          this.broadcast(presenceFrame(old.awarenessId, old.clock + 1, null));
        }
        this.store.put("agent", null);
        await this.schedule();
        return;
      }
      const identity = await this.authorize({
        kind: "agent",
        participantId: entry.id,
      });
      if (old && old.entry.id !== identity.participantId) {
        this.broadcast(presenceFrame(old.awarenessId, old.clock + 1, null));
      }
      const same = old?.entry.id === identity.participantId;
      const agent: AgentState = {
        awarenessId: same ? old.awarenessId : this.nextId(),
        clock: same ? old.clock + 1 : 1,
        entry: awarenessEntrySchema.parse({
          ...entry,
          color: identity.color,
          id: identity.participantId,
          kind: "agent",
          name: identity.name,
        }),
        expires: Date.now() + AGENT_MS,
      };
      this.store.put("agent", agent);
      this.broadcast(
        presenceFrame(agent.awarenessId, agent.clock, agent.entry)
      );
      await this.schedule();
    });
  }
  private async refreshSocket(socket: WebSocket, participantId?: string) {
    const state = session(socket);
    if (participantId && state.participantId !== participantId) {
      return;
    }
    try {
      const current = await this.authorize(state);
      const updated = { ...state, ...current };
      if (updated.expires <= Date.now()) {
        this.close(socket, "Expired");
        return;
      }
      if (updated.present) {
        updated.present = {
          ...updated.present,
          color: current.color,
          id: current.participantId,
          kind: current.kind,
          name: current.name,
        };
        updated.clock += 1;
      }
      socket.serializeAttachment(updated);
      if (updated.present) {
        this.broadcast(
          presenceFrame(updated.awarenessId, updated.clock, updated.present)
        );
      }
      socket.send(JSON.stringify({ role: current.role, type: "role" }));
    } catch {
      this.close(socket, "Revoked");
    }
  }
  refresh(participantId?: string) {
    return this.exclusive(async () => {
      await Promise.all(
        this.ctx
          .getWebSockets()
          .map((socket) => this.refreshSocket(socket, participantId))
      );
      try {
        await this.refreshPolicy();
      } catch {
        /* policy outage cannot block access invalidation; mutations refresh it again */
      }
      const agent = this.store.get<AgentState>("agent");
      if (agent && (!participantId || agent.entry.id === participantId)) {
        try {
          await this.authorize({
            kind: "agent",
            participantId: agent.entry.id,
          });
        } catch {
          this.broadcast(
            presenceFrame(agent.awarenessId, agent.clock + 1, null)
          );
          this.store.put("agent", null);
        }
      }
      await this.schedule();
    });
  }
  disconnect(participantId: string) {
    return this.exclusive(async () => {
      for (const socket of this.ctx.getWebSockets()) {
        if (session(socket).participantId === participantId) {
          this.close(socket, "Disconnected");
        }
      }
      await this.schedule();
    });
  }
  private async saveCheckpoint() {
    let pending = this.store.get<PendingSave>("pending");
    if (!pending) {
      pending = {
        checkpointId: crypto.randomUUID(),
        origins: [...this.meta.origins],
        restores: [...this.meta.restores],
        revision: this.meta.revision,
      };
      const { state } = this.snapshot();
      const created = pending;
      this.ctx.storage.transactionSync(() => {
        this.store.write("checkpoint", created.checkpointId, state);
        this.store.put("pending", pending);
      });
    }
    // pending is intentionally retained on every failure, including after a remote commit.
    const result = await this.env.ARTIFACT_ROOM_SERVICE.save(this.meta.scope, {
      ...pending,
      state: this.store.read("checkpoint", pending.checkpointId),
    });
    if (result.revision !== pending.revision) {
      throw new Error("Checkpoint acknowledgement mismatch");
    }
    this.ctx.storage.transactionSync(() => {
      this.meta.restores = this.meta.restores.filter(
        (r) => !pending.restores.some((p) => p.requestId === r.requestId)
      );
      this.meta.origins = this.meta.origins.filter(
        (o) => !pending.origins.some((p) => p.changeId === o.changeId)
      );
      this.meta.dirtySince =
        this.meta.revision === pending.revision ? null : Date.now();
      this.store.put("state", this.meta);
      this.store.put("pending", null);
      this.store.put("lastCheckpoint", result);
      this.store.remove("checkpoint", pending.checkpointId);
    });
    return { ...result, artifactId: this.meta.scope.artifactId };
  }
  checkpoint() {
    return this.exclusive(async () => {
      try {
        return await this.saveCheckpoint();
      } finally {
        await this.schedule();
      }
    });
  }
  override alarm(): Promise<void> {
    return this.exclusive(async () => {
      for (const socket of this.ctx.getWebSockets()) {
        if (session(socket).expires <= Date.now()) {
          this.close(socket, "Expired");
        }
      }
      const agent = this.store.get<AgentState>("agent");
      if (agent && agent.expires <= Date.now()) {
        this.broadcast(presenceFrame(agent.awarenessId, agent.clock + 1, null));
        this.store.put("agent", null);
      }
      if (
        this.store.get<PendingSave>("pending") ||
        (this.meta.dirtySince !== null &&
          this.meta.dirtySince + CHECKPOINT_MS <= Date.now())
      ) {
        try {
          await this.saveCheckpoint();
        } catch {
          /* next alarm retries the durable pending save */
        }
      }
      await this.schedule();
    });
  }
}
