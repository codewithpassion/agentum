import type { Blobs } from "@repo/services/events";

/** Adapts an R2 bucket to the `Blobs` store the events service uses for large payloads. */
export const r2Blobs = (bucket: R2Bucket): Blobs => ({
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? object.text() : null;
  },
  put: async (key, body) => {
    await bucket.put(key, body);
  },
});
