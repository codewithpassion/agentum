// The AppStore Durable Object (`idFromName(artifactId)`): the key-value storage
// of one app, in SQLite, so it survives versions. The logic lives in
// `app-store-core.ts`. This class wires `ctx.storage.sql` to it and exposes it
// over RPC. Only `port.ts` calls it.
import { DurableObject } from "cloudflare:workers";
import { createAppStoreCore } from "./app-store-core.ts";
import type { StorageArea, StoredItem } from "./types.ts";

export class AppStore extends DurableObject<Env> {
  readonly #core;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = createAppStoreCore({
      exec: (sql, ...params) => ctx.storage.sql.exec(sql, ...params).toArray(),
    });
    this.#core.init();
  }

  errorSlot(restoreDropped?: number): { dropped: number } | null {
    if (restoreDropped !== undefined) {
      this.#core.restoreErrorDrops(restoreDropped);
      return null;
    }
    return this.#core.errorSlot(Date.now());
  }

  deleteItem(area: StorageArea, viewerKey: string, key: string): void {
    this.#core.delete(area, viewerKey, key);
  }

  getItem(area: StorageArea, viewerKey: string, key: string): string | null {
    return this.#core.get(area, viewerKey, key);
  }

  listItems(
    area: StorageArea,
    viewerKey: string,
    prefix: string,
    limit: number
  ): StoredItem[] {
    return this.#core.list(area, viewerKey, prefix, limit);
  }

  setItem(
    area: StorageArea,
    viewerKey: string,
    key: string,
    value: string
  ): void {
    this.#core.set(area, viewerKey, key, value);
  }

  usage(): { bytes: number; maxBytes: number } {
    return this.#core.usage();
  }

  wipe(): void {
    this.#core.wipe();
  }
}
