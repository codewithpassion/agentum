import { expect, test } from "bun:test";
import { deleteObjects } from "./r2";

const countingBucket = () => {
  const calls: string[][] = [];
  const bucket = {
    delete: (keys: string | string[]) => {
      calls.push(typeof keys === "string" ? [keys] : keys);
      return Promise.resolve();
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
};

test("says nothing to R2 when there is nothing to delete", async () => {
  const { bucket, calls } = countingBucket();
  await deleteObjects(bucket, []);
  expect(calls).toEqual([]);
});

test("splits more keys than one call may name", async () => {
  const { bucket, calls } = countingBucket();
  const keys = Array.from({ length: 1001 }, (_, index) => `key-${index}`);

  await deleteObjects(bucket, keys);

  expect(calls.map((batch) => batch.length)).toEqual([1000, 1]);
  expect(calls.flat()).toEqual(keys);
});
