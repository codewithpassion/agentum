import type { FileBlobs } from "@repo/services/files";

/** Adapts an R2 bucket to the `FileBlobs` store the files service keeps uploads in. */
export const r2FileBlobs = (bucket: R2Bucket): FileBlobs => ({
  delete: async (key) => {
    await bucket.delete(key);
  },
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? object.body : null;
  },
  put: async (key, body, contentType) => {
    await bucket.put(key, body, { httpMetadata: { contentType } });
  },
});
