import { expect, test } from "bun:test";
import { r2LibraryBlobs } from "./r2-library.ts";

/** An in-memory stand-in for the R2 methods the adapter calls, with R2's conditional put and multi-key delete. */
const fakeBucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let counter = 0;
  const calls = { deleteCalls: 0 };
  const fake = {
    delete: (keys: string | string[]) => {
      calls.deleteCalls += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
      return Promise.resolve();
    },
    get: (key: string) => {
      const stored = objects.get(key);
      if (!stored) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(stored.bytes.slice().buffer),
        etag: stored.etag,
      });
    },
    put: (
      key: string,
      bytes: Uint8Array,
      options?: { onlyIf?: { etagMatches?: string } }
    ) => {
      const existing = objects.get(key);
      const wanted = options?.onlyIf?.etagMatches;
      if (wanted !== undefined && existing?.etag !== wanted) {
        return Promise.resolve(null);
      }
      counter += 1;
      const etag = `etag-${counter}`;
      objects.set(key, { bytes, etag });
      return Promise.resolve({ etag });
    },
  };
  return {
    bucket: fake as unknown as R2Bucket,
    calls,
    objects,
  };
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("put then get round-trips the bytes and the etag", async () => {
  const { bucket } = fakeBucket();
  const blobs = r2LibraryBlobs(bucket);
  const written = await blobs.put(
    "w/library/a.txt",
    new TextEncoder().encode("hello")
  );
  expect(written).not.toBeNull();
  const read = await blobs.get("w/library/a.txt");
  expect(read?.etag).toBe(written?.etag);
  expect(read && text(read.bytes)).toBe("hello");
});

test("put with the current etag succeeds and returns the new etag", async () => {
  const { bucket } = fakeBucket();
  const blobs = r2LibraryBlobs(bucket);
  const first = await blobs.put(
    "w/library/a.txt",
    new TextEncoder().encode("one")
  );
  const second = await blobs.put(
    "w/library/a.txt",
    new TextEncoder().encode("two"),
    { ifEtag: first?.etag }
  );
  expect(second).not.toBeNull();
  expect(second?.etag).not.toBe(first?.etag);
  const read = await blobs.get("w/library/a.txt");
  expect(read && text(read.bytes)).toBe("two");
});

test("put with a stale etag returns null and keeps the stored bytes", async () => {
  const { bucket } = fakeBucket();
  const blobs = r2LibraryBlobs(bucket);
  const first = await blobs.put(
    "w/library/a.txt",
    new TextEncoder().encode("one")
  );
  await blobs.put("w/library/a.txt", new TextEncoder().encode("two"));
  const stale = await blobs.put(
    "w/library/a.txt",
    new TextEncoder().encode("three"),
    { ifEtag: first?.etag }
  );
  expect(stale).toBeNull();
  const read = await blobs.get("w/library/a.txt");
  expect(read && text(read.bytes)).toBe("two");
});

test("put with an etag for a missing object returns null", async () => {
  const blobs = r2LibraryBlobs(fakeBucket().bucket);
  const result = await blobs.put(
    "w/library/none",
    new TextEncoder().encode("x"),
    {
      ifEtag: "etag-1",
    }
  );
  expect(result).toBeNull();
});

test("get of a missing key returns null", async () => {
  expect(
    await r2LibraryBlobs(fakeBucket().bucket).get("w/library/none")
  ).toBeNull();
});

test("delete removes several keys in one call", async () => {
  const { bucket, objects } = fakeBucket();
  const blobs = r2LibraryBlobs(bucket);
  await Promise.all(
    ["a", "b", "c"].map((name) =>
      blobs.put(`w/library/${name}`, new TextEncoder().encode(name))
    )
  );
  await blobs.delete(["w/library/a", "w/library/b"]);
  expect([...objects.keys()]).toEqual(["w/library/c"]);
});

test("delete of an empty list makes no bucket call", async () => {
  const { bucket, calls } = fakeBucket();
  await r2LibraryBlobs(bucket).delete([]);
  expect(calls.deleteCalls).toBe(0);
});

test("delete of 2,500 keys makes 3 bucket calls and removes all of them", async () => {
  const { bucket, calls, objects } = fakeBucket();
  const blobs = r2LibraryBlobs(bucket);
  const keys = Array.from({ length: 2500 }, (_, index) => `w/library/${index}`);
  for (const key of keys) {
    objects.set(key, { bytes: new Uint8Array(), etag: key });
  }
  await blobs.delete(keys);
  expect(calls.deleteCalls).toBe(3);
  expect(objects.size).toBe(0);
});
