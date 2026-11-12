import { describe, expect, test } from "bun:test";
import { fileKey, manifestKey, PRODUCT_FILES } from "./manifest.ts";
import { type DatedReleaseBucket, outdatedVersions } from "./store.ts";

const PRODUCT = "agentum-rs" as const;
const [FILE] = PRODUCT_FILES[PRODUCT];
if (!FILE) {
  throw new Error("the product ships no files");
}
const HASH = "a".repeat(64);
const NINTH = "0.1.0+cc9a8ae5";
const ELEVENTH = "0.1.0+b4c01389";

const manifestText = (version: string) =>
  JSON.stringify({
    files: { [FILE]: { sha256: HASH, size: 1 } },
    product: PRODUCT,
    version,
  });

/** A bucket holding `latest.json` for `latest` and a binary per uploaded version. */
const bucketWith = (
  latest: string,
  uploads: Record<string, string>,
  heads: string[] = []
): DatedReleaseBucket => ({
  get: (key) =>
    Promise.resolve(
      key === manifestKey(PRODUCT)
        ? {
            body: new ReadableStream(),
            httpEtag: "etag",
            size: 1,
            text: () => Promise.resolve(manifestText(latest)),
          }
        : null
    ),
  head: (key) => {
    heads.push(key);
    const found = Object.entries(uploads).find(
      ([version]) => fileKey(PRODUCT, version, FILE) === key
    );
    return Promise.resolve(found ? { uploaded: new Date(found[1]) } : null);
  },
});

const UPLOADS = {
  [NINTH]: "2026-11-09T10:00:00Z",
  [ELEVENTH]: "2026-11-11T10:00:00Z",
};

describe("outdatedVersions", () => {
  test("a machine on a newer build than latest gets no notice", async () => {
    expect(
      await outdatedVersions(bucketWith(NINTH, UPLOADS), PRODUCT, [ELEVENTH])
    ).toEqual([]);
  });

  test("a machine on an older build than latest gets the notice", async () => {
    expect(
      await outdatedVersions(bucketWith(ELEVENTH, UPLOADS), PRODUCT, [NINTH])
    ).toEqual([NINTH]);
  });

  test("a version R2 does not know gets no notice", async () => {
    expect(
      await outdatedVersions(bucketWith(ELEVENTH, UPLOADS), PRODUCT, [
        "0.1.0+dev",
        "0.1.0+deadbeef",
        "../x",
      ])
    ).toEqual([]);
  });

  test("the latest version itself gets no notice", async () => {
    expect(
      await outdatedVersions(bucketWith(ELEVENTH, UPLOADS), PRODUCT, [ELEVENTH])
    ).toEqual([]);
  });

  test("one head per distinct version, plus the latest", async () => {
    const heads: string[] = [];
    await outdatedVersions(bucketWith(ELEVENTH, UPLOADS, heads), PRODUCT, [
      NINTH,
      NINTH,
      NINTH,
    ]);
    expect(heads).toHaveLength(2);
  });

  test("no latest release, or an undated one, means no notice", async () => {
    const empty: DatedReleaseBucket = {
      get: () => Promise.resolve(null),
      head: () => Promise.resolve(null),
    };
    expect(await outdatedVersions(empty, PRODUCT, [NINTH])).toEqual([]);
    expect(
      await outdatedVersions(bucketWith(ELEVENTH, {}), PRODUCT, [NINTH])
    ).toEqual([]);
  });

  test("a bucket error rejects, for the caller to turn into no notice", async () => {
    const failing: DatedReleaseBucket = {
      ...bucketWith(ELEVENTH, UPLOADS),
      head: () => Promise.reject(new Error("r2 down")),
    };
    await expect(outdatedVersions(failing, PRODUCT, [NINTH])).rejects.toThrow(
      "r2 down"
    );
  });
});
