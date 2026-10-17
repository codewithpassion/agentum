import { expect, test } from "bun:test";
import { r2SkillBlobs } from "./r2-skills.ts";

/** An in-memory stand-in for the two R2 methods the adapter calls. */
const fakeBucket = () => {
  const objects = new Map<string, Uint8Array>();
  const fake = {
    get: (key: string) => {
      const stored = objects.get(key);
      return Promise.resolve(
        stored ? { arrayBuffer: () => Promise.resolve(stored.buffer) } : null
      );
    },
    head: (key: string) => Promise.resolve(objects.has(key) ? { key } : null),
    put: (key: string, value: Uint8Array) => {
      objects.set(key, value);
      return Promise.resolve(null);
    },
  };
  return { bucket: fake as unknown as R2Bucket, objects };
};

test("put stores the bytes under the key and get reads them back", async () => {
  const { bucket, objects } = fakeBucket();
  const blobs = r2SkillBlobs(bucket);
  await blobs.put("skill-blobs/abc", new Uint8Array([1, 2, 3]));
  expect([...(objects.get("skill-blobs/abc") ?? [])]).toEqual([1, 2, 3]);
  expect([...((await blobs.get("skill-blobs/abc")) ?? [])]).toEqual([1, 2, 3]);
});

test("exists tells a stored key from a missing one", async () => {
  const { bucket } = fakeBucket();
  const blobs = r2SkillBlobs(bucket);
  await blobs.put("skill-blobs/abc", new Uint8Array([1]));
  expect(await blobs.exists("skill-blobs/abc")).toBe(true);
  expect(await blobs.exists("skill-blobs/none")).toBe(false);
});

test("get returns null for a key with no object", async () => {
  const { bucket } = fakeBucket();
  expect(await r2SkillBlobs(bucket).get("skill-blobs/none")).toBeNull();
});
