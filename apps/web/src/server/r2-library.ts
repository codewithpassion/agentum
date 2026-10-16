import type { LibraryBlobs } from "@repo/services/library";

/** R2 takes at most this many keys in one `delete` call. */
const R2_DELETE_LIMIT = 1000;

/** Adapts an R2 bucket to the `LibraryBlobs` store the library service keeps file bytes in. */
export const r2LibraryBlobs = (bucket: R2Bucket): LibraryBlobs => ({
  delete: async (keys) => {
    const batches: string[][] = [];
    for (let index = 0; index < keys.length; index += R2_DELETE_LIMIT) {
      batches.push(keys.slice(index, index + R2_DELETE_LIMIT));
    }
    await Promise.all(batches.map((batch) => bucket.delete(batch)));
  },
  get: async (key) => {
    const object = await bucket.get(key);
    if (!object) {
      return null;
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      etag: object.etag,
    };
  },
  put: async (key, bytes, options) => {
    const object = await bucket.put(
      key,
      bytes,
      options?.ifEtag === undefined
        ? undefined
        : { onlyIf: { etagMatches: options.ifEtag } }
    );
    return object ? { etag: object.etag } : null;
  },
});
