import { expect, test } from "bun:test";
import { r2Blobs } from "./r2-blobs.ts";

/** An in-memory stand-in for the two R2 methods the adapter calls. */
const fakeBucket = () => {
  const objects = new Map<string, string>();
  const fake = {
    get: (key: string) => {
      const body = objects.get(key);
      if (body === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ text: () => Promise.resolve(body) });
    },
    put: (key: string, value: string) => {
      objects.set(key, value);
      return Promise.resolve(null);
    },
  };
  return fake as R2Bucket;
};

test("put then get returns the stored text", async () => {
  const blobs = r2Blobs(fakeBucket());
  await blobs.put("events/1", '{"big":true}');
  expect(await blobs.get("events/1")).toBe('{"big":true}');
});

test("get of a missing key returns null", async () => {
  const blobs = r2Blobs(fakeBucket());
  expect(await blobs.get("events/missing")).toBeNull();
});

test("put overwrites an existing key", async () => {
  const blobs = r2Blobs(fakeBucket());
  await blobs.put("events/1", "first");
  await blobs.put("events/1", "second");
  expect(await blobs.get("events/1")).toBe("second");
});
