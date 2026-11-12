import type { Product } from "@repo/protocol/releases";
// Reading release objects back from R2.

import {
  fileKey,
  isVersion,
  type Manifest,
  manifestKey,
  manifestSchema,
  PRODUCT_FILES,
} from "./manifest.ts";

/** The slice of an R2 object the release code reads. `R2ObjectBody` satisfies it. */
export interface ReleaseObject {
  body: ReadableStream;
  httpEtag: string;
  size: number;
  text: () => Promise<string>;
}

/** The slice of an R2 bucket the release code reads. The `FILES` binding satisfies it. */
export interface ReleaseBucket {
  get: (key: string) => Promise<ReleaseObject | null>;
}

/** A product's `latest.json`, or null when there is none or it is not a manifest. */
export const readManifest = async (
  bucket: ReleaseBucket,
  product: Product
): Promise<Manifest | null> => {
  const object = await bucket.get(manifestKey(product));
  if (!object) {
    return null;
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await object.text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The slice of an R2 bucket that dates release files: `get` for `latest.json`, `head` for upload times. */
export interface DatedReleaseBucket extends ReleaseBucket {
  head: (key: string) => Promise<{ uploaded: Date } | null>;
}

/** When a version's first binary reached R2, or null when R2 holds none. */
const uploadedAt = async (
  bucket: DatedReleaseBucket,
  product: Product,
  version: string
): Promise<number | null> => {
  const [file] = PRODUCT_FILES[product];
  if (!(file && isVersion(version))) {
    return null;
  }
  const head = await bucket.head(fileKey(product, version, file));
  return head ? head.uploaded.getTime() : null;
};

/**
 * Which of `versions` were published before the product's latest release.
 * Versions carry a commit hash, which has no order, so builds are ordered by
 * R2 upload time. A version R2 does not hold, or the latest itself, is not
 * listed. One `head()` per distinct version, plus one for the latest.
 */
export const outdatedVersions = async (
  bucket: DatedReleaseBucket,
  product: Product,
  versions: readonly string[]
): Promise<string[]> => {
  const latest = (await readManifest(bucket, product))?.version;
  if (!latest) {
    return [];
  }
  const latestAt = await uploadedAt(bucket, product, latest);
  if (latestAt === null) {
    return [];
  }
  const others = [...new Set(versions)].filter((version) => version !== latest);
  const times = await Promise.all(
    others.map((version) => uploadedAt(bucket, product, version))
  );
  return others.filter((_, index) => {
    const at = times[index];
    return at !== null && at !== undefined && at < latestAt;
  });
};
