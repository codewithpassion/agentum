import { expect, test } from "bun:test";
import { r2FileBlobs } from "./r2-files.ts";

/** An in-memory stand-in for the three R2 methods the adapter calls. */
const fakeBucket = () => {
  const objects = new Map<string, { blob: Blob; contentType?: string }>();
  const fake = {
    delete: (key: string) => {
      objects.delete(key);
      return Promise.resolve();
    },
    get: (key: string) => {
      const stored = objects.get(key);
      return Promise.resolve(stored ? { body: stored.blob.stream() } : null);
    },
    put: (
      key: string,
      blob: Blob,
      options?: { httpMetadata?: { contentType?: string } }
    ) => {
      objects.set(key, {
        blob,
        contentType: options?.httpMetadata?.contentType,
      });
      return Promise.resolve(null);
    },
  };
  return { bucket: fake as unknown as R2Bucket, objects };
};

test("put stores the blob with its content type, get streams it back", async () => {
  const { bucket, objects } = fakeBucket();
  const blobs = r2FileBlobs(bucket);
  await blobs.put("w/files/1", new Blob(["hello"]), "text/plain");
  expect(objects.get("w/files/1")?.contentType).toBe("text/plain");
  const body = await blobs.get("w/files/1");
  expect(await new Response(body).text()).toBe("hello");
});

test("get of a missing key returns null", async () => {
  expect(await r2FileBlobs(fakeBucket().bucket).get("w/files/none")).toBeNull();
});

test("delete removes the object", async () => {
  const { bucket } = fakeBucket();
  const blobs = r2FileBlobs(bucket);
  await blobs.put("w/files/1", new Blob(["x"]), "text/plain");
  await blobs.delete("w/files/1");
  expect(await blobs.get("w/files/1")).toBeNull();
});
