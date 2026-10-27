/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Network callbacks mutate lifecycle flags asynchronously; they are not constant across events. */
import {
  awarenessEntrySchema,
  type LiveJoinResult,
  liveRoleSchema,
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
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { z } from "zod";
import type {
  EditorRole,
  EditorSelection,
  PresencePort,
  TrustedParticipant,
} from "./editor-ports";

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
  failed: (message: string) => void;
  join: () => Promise<LiveJoinResult>;
  /** Refresh verified ownership before applying every room update. */
  policy: () => Promise<ReadonlySet<string>>;
  ready: (room: TicketedRoom) => void;
  roleChanged: (role: EditorRole) => void;
}
/** One connection owns one document. Reconnect creates a fresh instance so rejected
 * optimistic edits can never be offered back during a later sync handshake. */
export class TicketedRoom {
  readonly document = new Doc();
  readonly awareness = new Awareness(this.document);
  readonly policy = { ownBlobUrls: new Set<string>() };
  readonly presence: PresencePort;
  role: EditorRole = "viewer";
  private roster: readonly TrustedParticipant[] = [];
  private readonly listeners = new Set<() => void>();
  private socket?: WebSocket;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private readonly lifecycle = {
    assigned: false,
    disposed: false,
    synced: false,
  };
  private receiving = Promise.resolve();
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
          this.send(
            frame(
              1,
              encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
            )
          );
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
        this.awareness.setLocalState({ ...joined.participant });
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
      const urls = await this.options.policy();
      if (this.lifecycle.disposed) {
        return;
      }
      this.policy.ownBlobUrls = new Set(urls);
      applyUpdate(this.document, update, this);
      if (!this.lifecycle.synced && subtype === 1) {
        clearTimeout(this.connectionTimer);
        this.lifecycle.synced = true;
        this.options.ready(this);
      }
    } else if (type === 1) {
      const update = readVarUint8Array(decoder);
      this.receivePresence(update);
    } else {
      throw new Error("Unknown room frame");
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
        const entry = awarenessEntrySchema.parse(raw);
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
    this.awareness.setLocalStateField("cursor", { anchor: start, head: end });
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
    for (const waiter of this.selectionWaiters) {
      waiter.reject(new Error("Room disconnected"));
    }
    this.selectionWaiters.clear();
    this.socket?.close();
    this.awareness.destroy();
    // The React editor releases bindings before the parent destroys its document.
  }
}
