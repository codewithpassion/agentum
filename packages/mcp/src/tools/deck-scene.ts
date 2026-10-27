import {
  Deck,
  generateKeyBetween,
  parseSlide,
  type Theme,
} from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import {
  type AbstractType,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  type YEvent,
  type Map as YMap,
  YMapEvent,
} from "yjs";
import { ToolError } from "../result";
import {
  type DeckPort,
  type DeckReadInput,
  type DeckReadResult,
  type DeckWriteInput,
  type DeckWriteResult,
  deckReadInputSchema,
  deckWriteInputSchema,
} from "./deck";

/** Host must serialize room admission and retain this adapter for the room lifetime.
 * authorize must check principal/workspace, artifact kind, handed/created/in-artifact
 * scope and guest role on EVERY call; it throws ToolError on refusal. Presence is
 * authoritative room awareness, never caller input. Neither callback is optional. */
export interface DeckScenePorts {
  artifactId: string;
  authority: Deck;
  authorize: (action: "read" | "write", artifactId: string) => Promise<void>;
  ownsBlob: (path: string) => boolean;
  presence: () => DeckReadResult["present"];
}
interface Guard {
  history: Map<string, number>;
  theme: Theme;
}
interface SlideGuard extends Guard {
  coreRevision: string;
  id: string;
  reader: Deck;
}
const translate = (error: unknown): never => {
  if (error instanceof ToolError) {
    throw error;
  }
  if (
    error instanceof Error &&
    error.message === "invalid or expired observation"
  ) {
    throw new ToolError(
      "guard_mismatch",
      "Observation expired; read again and reconcile. Never retry by force."
    );
  }
  if (error instanceof Error && error.message.startsWith("/")) {
    // Preserve the authoritative core path and diagnostic verbatim.
    throw new ToolError("validation", error.message);
  }
  throw error;
};

/** DOM-free room adapter. Shadow authorities retain the core's opaque observations
 * and receive ORIGINAL Yjs updates, including edit/revert history (no hashes/ABA).
 * A complete batch runs only on this shadow, then one admitted original CRDT delta
 * reaches the authority. Failure discards the shadow and invalidates observations.
 * Never mutate authority.doc with untrusted bytes; use authority.applyUpdate. */
export class DeckSceneAdapter implements DeckPort {
  private stageDoc!: Doc;
  private stage!: Deck;
  private readers: Deck[] = [];
  private readonly slides = new Map<string, SlideGuard>();
  private readonly decks = new Map<string, Guard>();
  private readonly history = new Map<string, number>();
  private serial = 0;
  private closed = false;
  private readonly roots: YMap<unknown>[];
  private readonly changed = (events: YEvent<AbstractType<unknown>>[]) => {
    for (const event of events) {
      const root = this.roots.indexOf(event.currentTarget as YMap<unknown>);
      const base = [root === 0 ? "slides" : "meta", ...event.path.map(String)];
      const keys = event instanceof YMapEvent ? [...event.keysChanged] : [""];
      for (const key of keys) {
        const path = [...base, key];
        this.serial += 1;
        if (root === 1 && path.length <= 4) {
          this.history.set(`${path.join("/")}/@replace`, this.serial);
        }
        const depth =
          root === 0 ? Math.min(2, path.length) : Math.min(4, path.length);
        for (let n = 1; n <= depth; n += 1) {
          this.history.set(path.slice(0, n).join("/"), this.serial);
        }
      }
    }
    // Deleted ID churn cannot retain unbounded history. Eviction requires fresh reads.
    if (this.history.size > 4096) {
      this.slides.clear();
      this.decks.clear();
      this.history.clear();
    }
  };
  private readonly sync = (update: Uint8Array) =>
    this.stage.applyUpdate(update);

  private readonly ports: DeckScenePorts;

  constructor(ports: DeckScenePorts) {
    this.ports = ports;
    if (
      typeof ports.authorize !== "function" ||
      typeof ports.presence !== "function" ||
      typeof ports.ownsBlob !== "function"
    ) {
      throw new ToolError("forbidden", "Authorized scene ports are required.");
    }
    this.roots = [
      ports.authority.doc.getMap("slides"),
      ports.authority.doc.getMap("meta"),
    ];
    this.reset();
    for (const root of this.roots) {
      root.observeDeep(this.changed);
    }
    ports.authority.doc.on("update", this.sync);
  }
  destroy(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Lifecycle changes when the room owner calls destroy between requests.
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ports.authority.doc.off("update", this.sync);
    for (const root of this.roots) {
      root.unobserveDeep(this.changed);
    }
    this.disposeStage();
    this.slides.clear();
    this.decks.clear();
  }
  private disposeStage(): void {
    for (const reader of this.readers) {
      reader.destroy();
    }
    this.stage?.destroy();
    this.stageDoc?.destroy();
  }
  private reset(): void {
    this.disposeStage();
    this.slides.clear();
    this.decks.clear();
    this.stageDoc = new Doc({ gc: false });
    const options = { maxObservations: 128, ownsBlob: this.ports.ownsBlob };
    this.stage = new Deck(this.stageDoc, richTextCodec, options);
    this.stage.applyUpdate(encodeStateAsUpdate(this.ports.authority.doc));
    // Eight bounded observation stores allow an all-slides read (core limit 500).
    this.readers = Array.from(
      { length: 8 },
      () => new Deck(this.stageDoc, richTextCodec, options)
    );
  }
  private async authorize(
    action: "read" | "write",
    artifactId: string
  ): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Lifecycle changes when the room owner calls destroy between requests.
    if (this.closed) {
      throw new ToolError(
        "conflict",
        "Room closed; read from the current room."
      );
    }
    await this.ports.authorize(action, artifactId);
    if (artifactId !== this.ports.artifactId) {
      throw new ToolError("forbidden", "Artifact is outside this room.");
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Lifecycle changes when the room owner calls destroy between requests.
    if (this.closed) {
      throw new ToolError("conflict", "Room closed.");
    }
  }
  private guard(): Guard {
    return { history: new Map(this.history), theme: this.stage.theme() };
  }
  private unchanged(guard: Guard, path: string): boolean {
    // Parent replacements must invalidate leaf guards too.
    const parts = path.split("/");
    return (
      guard.history.get(path) === this.history.get(path) &&
      parts
        .slice(0, -1)
        .every(
          (_, i) =>
            guard.history.get(`${parts.slice(0, i + 1).join("/")}/@replace`) ===
            this.history.get(`${parts.slice(0, i + 1).join("/")}/@replace`)
        )
    );
  }
  async read(raw: DeckReadInput): Promise<DeckReadResult> {
    const input = deckReadInputSchema.parse(raw);
    await this.authorize("read", input.artifactId);
    try {
      const ids = input.slideIds ?? this.stage.ids();
      if (new Set(ids).size !== ids.length) {
        throw new ToolError("validation", "/slideIds: duplicate slide");
      }
      const guard = this.guard();
      const slides = ids.map((id, index) => {
        if (!this.stage.ids().includes(id)) {
          throw new ToolError("not_found", `/slide/${id}: slide missing`);
        }
        const reader = this.readers[index % this.readers.length];
        if (!reader) {
          throw new Error("Observation store unavailable");
        }
        const result = reader.readHtml(id);
        const revision = crypto.randomUUID();
        this.slides.set(revision, {
          ...guard,
          coreRevision: result.revision,
          id,
          reader,
        });
        return { html: result.html, id, revision };
      });
      const revision = crypto.randomUUID();
      this.decks.set(revision, guard);
      while (this.slides.size > 1024) {
        const oldest = this.slides.keys().next().value;
        if (oldest) {
          this.slides.delete(oldest);
        }
      }
      while (this.decks.size > 64) {
        const oldest = this.decks.keys().next().value;
        if (oldest) {
          this.decks.delete(oldest);
        }
      }
      return {
        artifactId: input.artifactId,
        deck: {
          order: this.stage.ids(),
          revision,
          sections: this.stage.sections(),
          theme: this.stage.theme(),
        },
        present: structuredClone(this.ports.presence()),
        slides,
      };
    } catch (error) {
      return translate(error);
    }
  }
  async write(raw: DeckWriteInput): Promise<DeckWriteResult> {
    const input = deckWriteInputSchema.parse(raw);
    await this.authorize("write", input.artifactId);
    const vector = encodeStateVector(this.ports.authority.doc);
    const result: DeckWriteResult = { applied: [], skipped: [] };
    try {
      input.ops.forEach((op, index) => {
        this.operation(op, index, result);
      });
      this.ports.authority.applyUpdate(
        encodeStateAsUpdate(this.stageDoc, vector)
      );
      // Capabilities are single-use even when every proposed key was skipped.
      for (const op of input.ops) {
        if ("revision" in op) {
          this.slides.delete(op.revision);
          this.decks.delete(op.revision);
        }
      }
      return result;
    } catch (error) {
      this.reset();
      return translate(error);
    }
  }
  private operation(
    op: DeckWriteInput["ops"][number],
    index: number,
    result: DeckWriteResult
  ): void {
    const applied = (keys: string[]) => result.applied.push({ index, keys });
    const skipped = (id: string, reason = "changed since read") =>
      result.skipped.push({ id, index, reason });
    if (op.op === "add") {
      const slide = parseSlide(op.html, richTextCodec);
      if (this.stage.ids().includes(slide.id)) {
        throw new ToolError("conflict", `/slide/${slide.id}: already exists`);
      }
      this.stage.addSlide(slide);
      applied([slide.id]);
      return;
    }
    if (op.op === "write" || op.op === "delete") {
      const guard = this.slides.get(op.revision);
      if (!guard || guard.id !== op.slideId) {
        throw new ToolError(
          "guard_mismatch",
          "Unknown observation; read again. Never retry by force."
        );
      }
      if (!this.stage.ids().includes(op.slideId)) {
        skipped(op.slideId, "slide deleted since read; do not recreate");
        return;
      }
      if (op.op === "delete") {
        if (!this.unchanged(guard, `slides/${op.slideId}`)) {
          skipped(op.slideId);
          return;
        }
        this.stage.deleteSlide(op.slideId);
        applied([op.slideId]);
        return;
      }
      const written = guard.reader.write(
        op.slideId,
        op.html,
        guard.coreRevision
      );
      applied(written.applied);
      for (const item of written.skipped) {
        skipped(item.id, item.reason);
      }
      return;
    }
    const guard = this.decks.get(op.revision);
    if (!guard) {
      throw new ToolError(
        "guard_mismatch",
        "Unknown deck observation; read again. Never retry by force."
      );
    }
    if (op.op === "reorder") {
      this.reorder(op.slideIds, guard, index, result);
      return;
    }
    this.theme(op.theme, guard, index, result);
  }
  private reorder(
    slideIds: string[],
    guard: Guard,
    index: number,
    result: DeckWriteResult
  ): void {
    if (!this.unchanged(guard, "slides")) {
      result.skipped.push({ id: "order", index, reason: "changed since read" });
      return;
    }
    const current = this.stage.ids();
    if (
      new Set(slideIds).size !== slideIds.length ||
      current.length !== slideIds.length ||
      current.some((id) => !slideIds.includes(id))
    ) {
      throw new ToolError(
        "validation",
        "/slideIds: reorder must contain every current slide exactly once"
      );
    }
    let order: string | null = null;
    for (const id of slideIds) {
      order = generateKeyBetween(order, null);
      this.stage.updateSlide(id, { order });
    }
    result.applied.push({ index, keys: ["order"] });
  }
  private theme(
    desired: Theme,
    guard: Guard,
    index: number,
    result: DeckWriteResult
  ): void {
    // Validate the complete desired theme, even keys which would be skipped.
    const validation = new Doc();
    const validator = new Deck(validation, richTextCodec);
    try {
      validator.setTheme(desired);
    } finally {
      validator.destroy();
      validation.destroy();
    }
    const merged = this.stage.theme();
    const keys: string[] = [];
    for (const area of ["colors", "fonts", "sizes"] as const) {
      for (const key of new Set([
        ...Object.keys(guard.theme[area]),
        ...Object.keys(desired[area]),
      ])) {
        if (guard.theme[area][key] === desired[area][key]) {
          continue;
        }
        const path = `meta/theme/${area}/${key}`;
        if (!this.unchanged(guard, path)) {
          result.skipped.push({
            id: path,
            index,
            reason: "changed since read",
          });
          continue;
        }
        const value = desired[area][key];
        if (value === undefined) {
          delete merged[area][key];
        } else {
          merged[area][key] = value;
        }
        keys.push(path);
      }
    }
    this.stage.setTheme(merged);
    result.applied.push({ index, keys });
  }
}

/** Creation adapter contract for artifact_create: validate an isolated initial
 * checkpoint BEFORE allocating/persisting a room. Caller authorizes creation and
 * owns artifact identity, persistence and URL. Does not mutate any existing room. */
export const createDeckCheckpoint = (
  input: { title: string; slides?: string[] },
  ownsBlob: DeckScenePorts["ownsBlob"]
): Uint8Array => {
  const doc = new Doc({ gc: false });
  const deck = new Deck(doc, richTextCodec, { ownsBlob });
  try {
    deck.setTitle(input.title);
    for (const html of input.slides ?? []) {
      deck.addSlide(parseSlide(html, richTextCodec));
    }
    deck.validate();
    return encodeStateAsUpdate(doc);
  } catch (error) {
    return translate(error);
  } finally {
    deck.destroy();
    doc.destroy();
  }
};
