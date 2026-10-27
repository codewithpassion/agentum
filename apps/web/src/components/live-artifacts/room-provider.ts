/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Network callbacks mutate lifecycle flags asynchronously; they are not constant across events. */
import {
  awarenessEntrySchema,
  type LiveJoinResult,
  liveRoleSchema,
  type RelativePositionJSON,
  relativePositionSchema,
} from "@repo/protocol/live";
import {
  createDecoder,
  readVarString,
  readVarUint,
  readVarUint8Array,
} from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { z } from "zod";
import type {
  AgentDecoration,
  EditorRole,
  EditorSelection,
  PresencePort,
  TrustedParticipant,
} from "./editor-ports";

export interface RoomPolicy {
  agentChanges?: readonly AgentDecoration[];
  ownBlobUrls: ReadonlySet<string>;
}

// y-tiptap publishes RelativePosition instances whose unused keys are null.
// The room contract deliberately accepts canonical JSON with unused keys omitted.
const positionId = z.object({
  client: z.int().nonnegative(),
  clock: z.int().nonnegative(),
});
const editorRelativeSchema = z
  .object({
    assoc: z.int().optional(),
    item: positionId.nullable().optional(),
    tname: z.string().nullable().optional(),
    type: positionId.nullable().optional(),
  })
  .transform(
    ({ assoc, item, tname, type }): RelativePositionJSON => ({
      assoc,
      item: item ?? undefined,
      tname: tname ?? undefined,
      type: type ?? undefined,
    })
  )
  .pipe(relativePositionSchema);
const roomCursorSchema = z.object({
  anchor: editorRelativeSchema,
  head: editorRelativeSchema,
});
const serverPresenceSchema = z
  .object({
    user: z.object({
      color: z.string(),
      id: z.string(),
      kind: z.enum(["member", "guest", "agent"]),
      name: z.string(),
    }),
  })
  .passthrough();
const controlSchema = z.discriminatedUnion("type", [
  z.object({
    awarenessId: z.int().nonnegative(),
    expiresAt: z.number(),
    type: z.literal("session"),
  }),
  z.object({ expiresAt: z.number(), type: z.literal("renewed") }),
  z.object({ role: liveRoleSchema, type: z.literal("role") }),
  z.object({ message: z.string(), type: z.literal("error") }),
]);
const frame = (type: number, payload: Uint8Array, subtype?: number) => {
  const encoder = createEncoder();
  writeVarUint(encoder, type);
  if (subtype !== undefined) {
    writeVarUint(encoder, subtype);
  }
  writeVarUint8Array(encoder, payload);
  return toUint8Array(encoder);
};
export interface RoomOptions {
  /** Called after authenticated WebSocket upgrade, before policy HTTP reads. */
  admitted?: () => void;
  failed: (message: string) => void;
  join: () => Promise<LiveJoinResult>;
  /** Refresh verified ownership before applying every room update. */
  policy: () => Promise<ReadonlySet<string> | RoomPolicy>;
  ready: (room: TicketedRoom) => void;
  roleChanged: (role: EditorRole) => void;
}
/** One connection owns one document. Reconnect creates a fresh instance so rejected
 * optimistic edits can never be offered back during a later sync handshake. */
export class TicketedRoom {
  readonly document = new Doc();
  readonly awareness = new Awareness(this.document);
  readonly policy = { ownBlobUrls: new Set<string>() };
  private agentChanges: readonly AgentDecoration[] = [];
  private readonly policyListeners = new Set<() => void>();
  readonly getAgentChanges = () => this.agentChanges;
  readonly subscribePolicy = (listener: () => void) => {
    this.policyListeners.add(listener);
    return () => this.policyListeners.delete(listener);
  };
  readonly presence: PresencePort;
  role: EditorRole = "viewer";
  private roster: readonly TrustedParticipant[] = [];
  private readonly listeners = new Set<() => void>();
  private socket?: WebSocket;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private policyTimer?: ReturnType<typeof setInterval>;
  private readonly lifecycle = {
    assigned: false,
    disposed: false,
    synced: false,
  };
  private receiving = Promise.resolve();
  // An explicit ask/comment attachment survives the editor cursor plugin's blur
  // updates. Only clearSelection consumes it; ordinary caret presence stays live.
  private attachedCursor?: { anchor: object; head: object };
  private readonly selectionWaiters = new Set<{
    key: string;
    resolve: () => void;
    reject: (cause: Error) => void;
  }>();
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private readonly options: RoomOptions;
  constructor(options: RoomOptions) {
    this.options = options;
    this.awareness.setLocalState(null);
    this.presence = {
      awareness: this.awareness,
      getSnapshot: () => this.roster,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      synced: true,
    };
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      if (
        origin !== this &&
        this.lifecycle.synced &&
        (this.role === "owner" || this.role === "editor")
      ) {
        this.send(frame(0, update, 2));
      }
    });
    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        if (
          origin !== this &&
          this.lifecycle.assigned &&
          [...added, ...updated, ...removed].includes(this.awareness.clientID)
        ) {
          this.send(this.localPresenceFrame());
        }
      }
    );
  }
  async connect() {
    try {
      const joined = await this.options.join();
      if (this.lifecycle.disposed) {
        return;
      }
      this.role = joined.role;
      this.options.roleChanged(this.role);
      const url = new URL(joined.roomUrl, window.location.origin);
      if (url.origin !== window.location.origin) {
        throw new Error("Untrusted room URL");
      }
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", joined.ticket);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.options.admitted?.();
      this.socket = socket;
      this.connectionTimer = setTimeout(
        () => this.fail(new Error("Room synchronization timed out")),
        30_000
      );
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        this.receiving = this.receiving
          .then(() => this.receive(event.data, joined))
          .catch((error: unknown) => this.fail(error));
      };
      socket.onclose = () => {
        if (!this.lifecycle.disposed) {
          this.fail(
            new Error(
              "Room disconnected. Reconnect to reload the accepted document."
            )
          );
        }
      };
      socket.onerror = () =>
        this.fail(new Error("Could not connect to the document room"));
    } catch (error) {
      this.fail(error);
    }
  }
  private localPresenceFrame() {
    const encoder = createEncoder();
    writeVarUint(encoder, 1);
    writeVarUint(encoder, this.awareness.clientID);
    writeVarUint(encoder, 0); // The room owns lifecycle clocks.
    const state = this.awareness.getLocalState();
    const cursor = roomCursorSchema.safeParse(
      this.attachedCursor ?? state?.cursor
    );
    const value = cursor.success ? { cursor: cursor.data } : {};
    // Tiptap sends cursor:null on blur. The room accepts an omitted cursor, not
    // null; never forward editor-only user data or unknown presence fields.
    writeVarString(encoder, JSON.stringify(state === null ? null : value));
    return frame(1, toUint8Array(encoder));
  }
  private send(bytes: Uint8Array | string) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    }
  }
  private scheduleRenewal(expiresAt: number) {
    clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(
      () => {
        this.options
          .join()
          .then((joined) => {
            if (this.lifecycle.disposed) {
              return;
            }
            if (joined.role !== this.role) {
              this.role = joined.role;
              this.options.roleChanged(this.role);
              this.fail(
                new Error(
                  "Document permissions changed. Reconnect to refresh access."
                )
              );
              return;
            }
            this.send(JSON.stringify({ ticket: joined.ticket, type: "renew" }));
            // A missing renewed control must not leave the editor writable indefinitely.
            this.renewTimer = setTimeout(
              () => this.fail(new Error("Room renewal was not acknowledged")),
              15_000
            );
          })
          .catch((error: unknown) => this.fail(error));
      },
      Math.max(1000, expiresAt - Date.now() - 60_000)
    );
  }
  private receiveControl(data: string, joined: LiveJoinResult) {
    const control = controlSchema.parse(JSON.parse(data));
    switch (control.type) {
      case "error":
        throw new Error(control.message);
      case "role":
        if (control.role === this.role) {
          return;
        }
        this.role = control.role;
        this.options.roleChanged(this.role);
        // Drop all local optimistic state on authorization changes.
        throw new Error(
          "Document permissions changed. Reconnect to refresh access."
        );
      case "renewed":
        this.scheduleRenewal(control.expiresAt);
        return;
      case "session": {
        if (this.lifecycle.assigned) {
          throw new Error("Duplicate room session");
        }
        this.awareness.clientID = control.awarenessId;
        this.lifecycle.assigned = true;
        this.roster = [
          {
            clientId: control.awarenessId,
            color: joined.participant.color,
            id: joined.participant.id,
            kind: joined.participant.kind,
            name: joined.participant.name,
          },
        ];
        this.awareness.setLocalState({ user: { ...joined.participant } });
        this.scheduleRenewal(control.expiresAt);
        this.send(frame(0, encodeStateVector(this.document), 0));
        const query = createEncoder();
        writeVarUint(query, 3);
        this.send(toUint8Array(query));
        return;
      }
      default:
        throw new Error("Unknown room control");
    }
  }
  private async receive(data: string | ArrayBuffer, joined: LiveJoinResult) {
    if (this.lifecycle.disposed) {
      return;
    }
    if (typeof data === "string") {
      this.receiveControl(data, joined);
      return;
    }
    const decoder = createDecoder(new Uint8Array(data));
    const type = readVarUint(decoder);
    if (type === 0) {
      const subtype = readVarUint(decoder);
      const update = readVarUint8Array(decoder);
      if (subtype === 0) {
        this.send(frame(0, encodeStateAsUpdate(this.document, update), 1));
        return;
      }
      if (subtype !== 1 && subtype !== 2) {
        throw new Error("Unknown document frame");
      }
      if (!(await this.refreshPolicy())) {
        return;
      }
      applyUpdate(this.document, update, this);
      this.publishPolicy();
      if (!this.lifecycle.synced && subtype === 1) {
        clearTimeout(this.connectionTimer);
        this.lifecycle.synced = true;
        this.options.ready(this);
        this.policyTimer = setInterval(() => {
          this.receiving = this.receiving
            .then(async () => {
              if (!this.lifecycle.disposed && (await this.refreshPolicy())) {
                this.publishPolicy();
              }
            })
            .catch((error: unknown) => this.fail(error));
        }, 30_000);
      }
    } else if (type === 1) {
      const update = readVarUint8Array(decoder);
      this.receivePresence(update);
    } else {
      throw new Error("Unknown room frame");
    }
  }
  private async refreshPolicy() {
    const manifest = await this.options.policy();
    if (this.lifecycle.disposed) {
      return false;
    }
    if ("ownBlobUrls" in manifest) {
      this.policy.ownBlobUrls = new Set(manifest.ownBlobUrls);
      this.agentChanges = manifest.agentChanges ?? [];
    } else {
      this.policy.ownBlobUrls = new Set(manifest);
      this.agentChanges = [];
    }
    return true;
  }
  private publishPolicy() {
    for (const listener of this.policyListeners) {
      listener();
    }
  }
  private receivePresence(update: Uint8Array) {
    const entries = createDecoder(update);
    const count = readVarUint(entries);
    const roster = new Map(this.roster.map((entry) => [entry.clientId, entry]));
    for (let index = 0; index < count; index += 1) {
      const clientId = readVarUint(entries);
      readVarUint(entries);
      const raw: unknown = JSON.parse(readVarString(entries));
      if (raw === null) {
        roster.delete(clientId);
      } else {
        // Only authenticated server frames feed the identity roster; raw local user fields never do.
        const { user, ...fields } = serverPresenceSchema.parse(raw);
        const entry = awarenessEntrySchema.parse({ ...fields, ...user });
        if (clientId === this.awareness.clientID) {
          for (const waiter of this.selectionWaiters) {
            if (JSON.stringify(entry.cursor) === waiter.key) {
              waiter.resolve();
              this.selectionWaiters.delete(waiter);
            }
          }
        }
        roster.set(clientId, {
          ...entry,
          clientId,
          status: entry.status
            ? { text: entry.status, updatedAt: Date.now() }
            : undefined,
        });
      }
    }
    applyAwarenessUpdate(this.awareness, update, this);
    this.roster = [...roster.values()];
    for (const listener of this.listeners) {
      listener();
    }
  }
  /** Keep the selected relative range alive when the panel takes focus. */
  select(start: object, end: object) {
    this.attachedCursor = { anchor: start, head: end };
    this.awareness.setLocalStateField("cursor", this.attachedCursor);
  }
  clearSelection() {
    this.attachedCursor = undefined;
    this.awareness.setLocalStateField("cursor", null);
  }
  async confirmSelection(selection: EditorSelection): Promise<void> {
    if (this.lifecycle.disposed || !this.lifecycle.synced) {
      throw new Error("Reconnect before asking about a selection");
    }
    const cursor = {
      anchor: relativePositionSchema.parse(selection.start),
      head: relativePositionSchema.parse(selection.end),
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.selectionWaiters.delete(waiter);
        reject(
          new Error("Selection was not acknowledged by the room. Try again.")
        );
      }, 5000);
      const waiter = {
        key: JSON.stringify(cursor),
        reject: (cause: Error) => {
          clearTimeout(timer);
          reject(cause);
        },
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.selectionWaiters.add(waiter);
      this.attachedCursor = cursor;
      this.awareness.setLocalStateField("cursor", cursor);
    });
  }
  private fail(error: unknown) {
    if (this.lifecycle.disposed) {
      return;
    }
    this.options.failed(error instanceof Error ? error.message : "Room failed");
    this.dispose();
  }
  dispose() {
    if (this.lifecycle.disposed) {
      return;
    }
    this.lifecycle.disposed = true;
    clearTimeout(this.renewTimer);
    clearTimeout(this.connectionTimer);
    clearInterval(this.policyTimer);
    for (const waiter of this.selectionWaiters) {
      waiter.reject(new Error("Room disconnected"));
    }
    this.selectionWaiters.clear();
    this.socket?.close();
    this.awareness.destroy();
    // The React editor releases bindings before the parent destroys its document.
  }
}
