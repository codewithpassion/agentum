import type { LibraryBlobs } from "../library.ts";

export type MemoryLibraryBlobs = LibraryBlobs & {
  /** Every key `get`, `put` or `delete` was called with, in order. */
  touched: string[];
  objects: Map<string, { bytes: Uint8Array; etag: string }>;
};

/**
 * An in-memory `LibraryBlobs` for tests. Etags count up, so a rewrite with the
 * same bytes still changes the etag. `put` checks and stores in one step, as
 * R2 does for a conditional put.
 */
export const memoryLibraryBlobs = (): MemoryLibraryBlobs => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const touched: string[] = [];
  let version = 0;
  return {
    delete: (keys) => {
      touched.push(...keys);
      for (const key of keys) {
        objects.delete(key);
      }
      return Promise.resolve();
    },
    get: (key) => {
      touched.push(key);
      const object = objects.get(key);
      return Promise.resolve(
        object ? { bytes: object.bytes.slice(), etag: object.etag } : null
      );
    },
    objects,
    put: (key, bytes, options) => {
      touched.push(key);
      if (
        options?.ifEtag !== undefined &&
        objects.get(key)?.etag !== options.ifEtag
      ) {
        return Promise.resolve(null);
      }
      version += 1;
      const etag = `etag-${version}`;
      objects.set(key, { bytes: bytes.slice(), etag });
      return Promise.resolve({ etag });
    },
    touched,
  };
};
