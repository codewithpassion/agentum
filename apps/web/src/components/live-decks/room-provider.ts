/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Network callbacks mutate lifecycle flags asynchronously; they are not constant across events. */

import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import {
  type DeckRoomSession,
  presentationControlSchema,
} from "@repo/protocol/deck";
import {
  awarenessEntrySchema,
  type LiveJoinResult,
  liveRoleSchema,
} from "@repo/protocol/live";
import {
  createDecoder,
  type Decoder,
  hasContent,
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
import { Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { z } from "zod";
import type { DeckParticipant, DeckWhere, PresentationPosition } from "./ports";

type EditorRole = LiveJoinResult["role"];
export interface RoomPolicy {
  ownBlobUrls: ReadonlySet<string>;
}
const serverPresenceSchema = z
  .object({
    user: z.object({
      color: awarenessEntrySchema.shape.color,
      id: awarenessEntrySchema.shape.id,
      kind: awarenessEntrySchema.shape.kind,
      name: awarenessEntrySchema.shape.name,
    }),
  })
  .passthrough();
const presentationPositionSchema = z.object({
  build: z.int().nonnegative(),
  presenterId: z.string(),
  slideId: z.string(),
});
const controlSchema = z.discriminatedUnion("type", [
  z.object({
    awarenessId: z.int().nonnegative(),
    epoch: z.string().min(1),
    expiresAt: z.number(),
    kind: z.literal("deck"),
    ownBlobUrls: z.array(z.string()),
    participant: z.object({
      color: awarenessEntrySchema.shape.color,
      id: awarenessEntrySchema.shape.id,
      kind: awarenessEntrySchema.shape.kind,
      name: awarenessEntrySchema.shape.name,
    }),
    role: liveRoleSchema,
    type: z.literal("session"),
  }),
  z.object({ expiresAt: z.number(), type: z.literal("renewed") }),
  z.object({ role: liveRoleSchema, type: z.literal("role") }),
  z.object({ message: z.string(), type: z.literal("error") }),
]);
const presentationMessageSchema = z.discriminatedUnion("type", [
  z.object({
    position: presentationPositionSchema.nullable(),
    type: z.literal("presentation"),
  }),
  z.object({
    expiresAt: z.number().optional(),
    leaseId: z.string().optional(),
    ok: z.boolean(),
    reason: z.string().optional(),
    requestId: z.string(),
    type: z.literal("presentation-result"),
  }),
]);
const locationSchema = z.object({
  pointer: awarenessEntrySchema.shape.pointer,
  selection: awarenessEntrySchema.shape.selection,
  slideId: awarenessEntrySchema.shape.slideId,
});
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
  policy: () => Promise<ReadonlySet<string> | RoomPolicy>;
  ready: (room: TicketedDeckRoom) => void;
  roleChanged: (role: EditorRole) => void;
}
/** One connection owns one deck. Reconnect creates a fresh instance so rejected
 * optimistic edits can never be offered back during a later sync handshake. */
export class TicketedDeckRoom {
  readonly document = new Doc();
  readonly awareness = new Awareness(this.document);
  readonly policy = { ownBlobUrls: new Set<string>() };
  readonly deck = new Deck(this.document, richTextCodec, {
    ownsBlob: (path) => this.policy.ownBlobUrls.has(path),
  });
  get participants(): readonly DeckParticipant[] {
    return this.roster;
  }
  get selfId() {
    return (
      this.roster.find((entry) => entry.clientId === this.awareness.clientID)
        ?.id ?? ""
    );
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  role: EditorRole = "viewer";
  epoch?: string;
  private roster: readonly (DeckParticipant & { clientId: number })[] = [];
  private readonly listeners = new Set<() => void>();
  private socket?: WebSocket;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private policyTimer?: ReturnType<typeof setInterval>;
  private readonly lifecycle = {
    assigned: false,
    disposed: false,
    synced: false,
  };
  presentation: PresentationPosition | null = null;
  private leaseId?: string;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: { leaseId?: string }) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly locationWaiters = new Set<{
    key: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private presentationQueue: Promise<void> = Promise.resolve();
  private applying = false;
  private receiving = Promise.resolve();
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private readonly options: RoomOptions;
  constructor(options: RoomOptions) {
    this.options = options;
    this.awareness.setLocalState(null);
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      if (
        origin !== this &&
        !this.applying &&
        this.lifecycle.synced &&
        (this.role === "owner" || this.role === "editor")
      ) {
        try {
          // Tiptap may materialize an empty local migration map during undo.
          // Validate the actual encoded wire state; empty local roots are not encoded.
          const candidate = new Deck(new Doc(), richTextCodec, {
            ownsBlob: (path) => this.policy.ownBlobUrls.has(path),
          });
          try {
            candidate.applyUpdate(encodeStateAsUpdate(this.document));
          } finally {
            candidate.destroy();
            candidate.doc.destroy();
          }
          this.send(frame(0, update, 2));
        } catch (error) {
          this.fail(error);
        }
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
          !this.lifecycle.disposed &&
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
              "Room disconnected. Reconnect to reload the accepted deck."
            )
          );
        }
      };
      socket.onerror = () =>
        this.fail(new Error("Could not connect to the deck room"));
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
    const cursor = locationSchema.safeParse(state);
    const value = cursor.success ? cursor.data : {};
    // Location replaces the previous ephemeral value; identity is supplied by the room.
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
                  "Deck permissions changed. Reconnect to refresh access."
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
  private receivePresentation(raw: unknown) {
    const presentation = presentationMessageSchema.safeParse(raw);
    if (presentation.success) {
      const message = presentation.data;
      if (message.type === "presentation") {
        this.presentation = message.position;
        this.publishPolicy();
      } else {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
          if (message.ok) {
            pending.resolve(message);
          } else {
            pending.reject(new Error(message.reason ?? "Presentation refused"));
          }
        }
      }
      return true;
    }
    return false;
  }
  private receiveControl(data: string, joined: LiveJoinResult) {
    const raw: unknown = JSON.parse(data);
    if (this.receivePresentation(raw)) {
      return;
    }
    const control = controlSchema.parse(raw);
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
          "Deck permissions changed. Reconnect to refresh access."
        );
      case "renewed":
        this.scheduleRenewal(control.expiresAt);
        return;
      case "session": {
        if (this.lifecycle.assigned) {
          throw new Error("Duplicate room session");
        }
        if (control.role !== this.role) {
          throw new Error("Room admission role changed");
        }
        const admission: DeckRoomSession = control;
        this.epoch = admission.epoch;
        if (admission.participant.id !== joined.participant.id) {
          throw new Error("Room participant changed during admission");
        }
        this.policy.ownBlobUrls = new Set(admission.ownBlobUrls);
        this.awareness.clientID = control.awarenessId;
        this.lifecycle.assigned = true;
        this.roster = [
          {
            clientId: control.awarenessId,
            ...admission.participant,
          },
        ];
        this.awareness.setLocalState({});
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
    if (!this.lifecycle.assigned) {
      throw new Error("Room data before trusted session assignment");
    }
    const decoder = createDecoder(new Uint8Array(data));
    const type = readVarUint(decoder);
    if (type === 0) {
      await this.receiveSync(decoder);
    } else if (type === 1) {
      const update = readVarUint8Array(decoder);
      if (hasContent(decoder)) {
        throw new Error("Trailing deck frame bytes");
      }
      this.receivePresence(update);
    } else {
      throw new Error("Unknown room frame");
    }
  }
  private async receiveSync(decoder: Decoder) {
    const subtype = readVarUint(decoder);
    const update = readVarUint8Array(decoder);
    if (hasContent(decoder)) {
      throw new Error("Trailing deck frame bytes");
    }
    if (subtype === 0) {
      this.send(frame(0, encodeStateAsUpdate(this.document, update), 1));
      return;
    }
    if (subtype !== 1 && subtype !== 2) {
      throw new Error("Unknown deck frame");
    }
    if (!(await this.refreshPolicy())) {
      return;
    }
    this.applying = true;
    try {
      this.deck.applyUpdate(update);
    } finally {
      this.applying = false;
    }
    if (!this.document.getMap("meta").has("theme")) {
      throw new Error("Deck theme is not initialized by the authority");
    }
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
  }
  private async refreshPolicy() {
    const manifest = await this.options.policy();
    if (this.lifecycle.disposed) {
      return false;
    }
    if ("ownBlobUrls" in manifest) {
      this.policy.ownBlobUrls = new Set(manifest.ownBlobUrls);
    } else {
      this.policy.ownBlobUrls = new Set(manifest);
    }
    return true;
  }
  private publishPolicy() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  private receivePresence(update: Uint8Array) {
    const entries = createDecoder(update);
    const count = readVarUint(entries);
    if (count > 1000) {
      throw new Error("Room participant limit exceeded");
    }
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
          const key = JSON.stringify([entry.slideId, entry.selection ?? []]);
          for (const waiter of this.locationWaiters) {
            if (waiter.key === key) {
              waiter.resolve();
              this.locationWaiters.delete(waiter);
            }
          }
        }
        roster.set(clientId, {
          ...entry,
          clientId,
          status: entry.status,
        });
      }
    }
    if (hasContent(entries)) {
      throw new Error("Trailing awareness bytes");
    }
    applyAwarenessUpdate(this.awareness, update, this);
    this.roster = [...roster.values()];
    for (const listener of this.listeners) {
      listener();
    }
  }
  private readonly renewPresentation = () => {
    this.requestPresentation("renew").catch((error: unknown) =>
      this.fail(error)
    );
  };
  private requestPresentation(
    action: "acquire" | "renew" | "position" | "release",
    position?: PresentationPosition
  ) {
    return new Promise<{ leaseId?: string }>((resolve, reject) => {
      if (this.lifecycle.disposed || !this.lifecycle.synced) {
        reject(new Error("Room disconnected"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.fail(new Error("Presentation acknowledgement timed out"));
      }, 5000);
      this.pending.set(requestId, { reject, resolve, timer });
      try {
        this.send(
          JSON.stringify(
            presentationControlSchema.parse({
              action,
              requestId,
              type: "presentation",
              ...(this.leaseId ? { leaseId: this.leaseId } : {}),
              ...position,
            })
          )
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Invalid presentation request")
        );
      }
    });
  }
  presentToEveryone = (
    position: PresentationPosition | null
  ): Promise<void> => {
    const operation = this.presentationQueue.then(async () => {
      if (position === null) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = undefined;
        if (this.leaseId) {
          await this.requestPresentation("release");
          this.leaseId = undefined;
        }
        return;
      }
      if (this.role !== "owner" && this.role !== "editor") {
        throw new Error("Presentation requires editing permission");
      }
      const result = await this.requestPresentation(
        this.leaseId ? "position" : "acquire",
        position
      );
      if (result.leaseId) {
        this.leaseId = result.leaseId;
      }
      if (!this.leaseTimer) {
        this.leaseTimer = setInterval(this.renewPresentation, 5000);
      }
    });
    this.presentationQueue = operation.catch(() => undefined);
    return operation;
  };
  async confirmLocation(where: DeckWhere) {
    if (!this.lifecycle.synced || this.lifecycle.disposed) {
      throw new Error("Reconnect before asking");
    }
    if (!this.deck.ids().includes(where.slideId)) {
      throw new Error("Selected slide was removed");
    }
    const location = { selection: where.elementIds, slideId: where.slideId };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.locationWaiters.delete(waiter);
        reject(new Error("Selection was not acknowledged by the room"));
      }, 5000);
      const waiter = {
        key: JSON.stringify([location.slideId, location.selection]),
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.locationWaiters.add(waiter);
      this.publishPresence(location);
    });
  }
  /** Service RPC state uses the same validated ingress as WebSocket updates. */
  applyAuthority(state: readonly number[]): Promise<void> {
    const admitted = this.receiving.then(async () => {
      if (this.lifecycle.disposed) {
        throw new Error("Room disconnected");
      }
      if (!(await this.refreshPolicy())) {
        throw new Error("Room disconnected");
      }
      this.applying = true;
      try {
        this.deck.applyUpdate(Uint8Array.from(state));
        if (!this.document.getMap("meta").has("theme")) {
          throw new Error("Deck theme is not initialized by the authority");
        }
      } finally {
        this.applying = false;
      }
      this.publishPolicy();
    });
    this.receiving = admitted.catch((cause: unknown) => this.fail(cause));
    return admitted;
  }
  async refreshOwnership() {
    await this.refreshPolicy();
    this.publishPolicy();
  }
  publishPresence = (location: {
    slideId?: string;
    selection: string[];
    pointer?: { x: number; y: number };
  }) => {
    if (!this.lifecycle.disposed && this.lifecycle.synced) {
      this.awareness.setLocalState(locationSchema.parse(location));
    }
  };
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
    clearInterval(this.leaseTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Room disconnected"));
    }
    this.pending.clear();
    for (const waiter of this.locationWaiters) {
      waiter.reject(new Error("Room disconnected"));
    }
    this.locationWaiters.clear();
    this.socket?.close();
    this.awareness.destroy();
    // The React editor releases bindings before the parent destroys its deck.
  }
}
