import type { SkillBlobs } from "@repo/services/skills-store";

/** Adapts an R2 bucket to the `SkillBlobs` store the skills store keeps file bytes in. */
export const r2SkillBlobs = (bucket: R2Bucket): SkillBlobs => ({
  exists: async (key) => (await bucket.head(key)) !== null,
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  put: async (key, bytes) => {
    await bucket.put(key, bytes);
  },
});
