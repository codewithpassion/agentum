// Reading release objects back from R2.

import {
  type Manifest,
  manifestKey,
  manifestSchema,
  type Product,
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
