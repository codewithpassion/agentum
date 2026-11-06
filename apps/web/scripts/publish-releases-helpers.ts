import type { Product } from "@repo/protocol/releases";
// Pure helpers for publish-releases.ts. Hashing happens in memory, and nothing
// here touches the network or the filesystem. Tested in publish-releases.test.ts.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { JSONC } from "bun";
import { z } from "zod";
import {
  fileKey,
  isVersion,
  type Manifest,
  manifestKey,
  manifestSchema,
  PRODUCT_FILES,
  releaseVersion,
  serializeManifest,
} from "../src/server/releases/manifest.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Where each product's build leaves its binaries, relative to the repo root. */
const ARTIFACT_DIRS: Record<Product, string> = {
  agentum: "apps/daemon/dist",
  "agentum-rs": "apps/agentum/dist",
  "hm-computer": "apps/computer/bin",
};

const BINARY_TYPE = "application/octet-stream";
const MANIFEST_TYPE = "application/json";

const USAGE =
  "Usage: bun scripts/publish-releases.ts --env staging|production [--allow-dirty] [--dry-run]";

export type PublishEnv = "staging" | "production";

export interface PublishArgs {
  allowDirty: boolean;
  dryRun: boolean;
  env: PublishEnv;
}

export const parseArgs = (argv: readonly string[]): PublishArgs => {
  const args = [...argv];
  let env: string | undefined;
  let allowDirty = false;
  let dryRun = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--env") {
      env = args.shift();
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--allow-dirty") {
      allowDirty = true;
    } else {
      throw new Error(`Unknown argument "${arg}". ${USAGE}`);
    }
  }
  if (env === undefined) {
    throw new Error(`--env is required. ${USAGE}`);
  }
  if (env !== "staging" && env !== "production") {
    throw new Error(
      `--env must be staging or production, got "${env}". ${USAGE}`
    );
  }
  return { allowDirty, dryRun, env };
};

/** `<package version>+<short commit>`, checked against the release pattern. */
export const buildVersion = (
  packageVersion: string,
  shortCommit: string
): string => {
  const version = releaseVersion(packageVersion, shortCommit);
  if (!isVersion(version)) {
    throw new Error(
      `"${version}" is not a release version. Expected <x.y.z>+<commit>.`
    );
  }
  return version;
};

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface BuiltFile {
  bytes: Uint8Array;
  name: string;
}

/** The manifest for one product's build. The files must be exactly the product's files. */
export const buildManifest = (
  product: Product,
  version: string,
  files: readonly BuiltFile[]
): Manifest => {
  const expected = [...PRODUCT_FILES[product]].sort().join("\n");
  const actual = files
    .map((file) => file.name)
    .sort()
    .join("\n");
  if (expected !== actual) {
    throw new Error(
      `${product} must ship ${PRODUCT_FILES[product].join(", ")}, got ${files.map((file) => file.name).join(", ")}.`
    );
  }
  return manifestSchema.parse({
    files: Object.fromEntries(
      files.map(({ name, bytes }) => [
        name,
        { sha256: sha256Hex(bytes), size: bytes.byteLength },
      ])
    ),
    product,
    version,
  });
};

/** True when the live latest.json is a valid manifest for this same version. */
export const shouldSkip = (
  existingManifestText: string | null,
  version: string
): boolean => {
  if (existingManifestText === null) {
    return false;
  }
  let json: unknown;
  try {
    json = JSON.parse(existingManifestText);
  } catch {
    return false;
  }
  const parsed = manifestSchema.safeParse(json);
  return parsed.success && parsed.data.version === version;
};

/** Refuses a dirty tree, so the build matches the commit it is named after. */
export const assertCleanTree = (
  statusPorcelain: string,
  allowDirty: boolean
): void => {
  if (allowDirty || statusPorcelain.trim() === "") {
    return;
  }
  throw new Error(
    `The working tree has uncommitted changes:\n${statusPorcelain.trimEnd()}\nCommit them, or pass --allow-dirty to publish anyway.`
  );
};

/** The directory a product's build writes its binaries into. */
export const artifactDir = (product: Product): string =>
  join(REPO_ROOT, ARTIFACT_DIRS[product]);

/** Where a built binary sits on disk. */
export const artifactPath = (product: Product, file: string): string =>
  join(artifactDir(product), file);

export type UploadSource = { filePath: string } | { body: string };
export type UploadItem = UploadSource & { key: string; contentType: string };

/** The R2 operations the publish script needs. The real one calls wrangler. */
export interface Uploader {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    source: UploadSource,
    contentType: string
  ) => Promise<void>;
}

/**
 * The uploads for one product, in order: every binary, then latest.json. The
 * manifest is last, so a failed upload leaves `latest` on the old build.
 */
export const uploadPlan = (
  product: Product,
  version: string,
  manifest: Manifest
): UploadItem[] => {
  const binaries: UploadItem[] = Object.keys(manifest.files).map((name) => ({
    contentType: BINARY_TYPE,
    filePath: artifactPath(product, name),
    key: fileKey(product, version, name),
  }));
  return [
    ...binaries,
    {
      body: serializeManifest(manifest),
      contentType: MANIFEST_TYPE,
      key: manifestKey(product),
    },
  ];
};

const r2Buckets = z.array(
  z.object({ binding: z.string(), bucket_name: z.string() })
);
const wranglerConfig = z.object({
  env: z
    .record(z.string(), z.object({ r2_buckets: r2Buckets.optional() }))
    .optional(),
  r2_buckets: r2Buckets.optional(),
});

/** The bucket bound as `FILES`: top level for production, `env.staging` for staging. */
export const bucketNameFor = (
  env: PublishEnv,
  wranglerJsoncText: string
): string => {
  const config = wranglerConfig.parse(JSONC.parse(wranglerJsoncText));
  const scope = env === "production" ? config : config.env?.[env];
  const bucket = scope?.r2_buckets?.find(
    (binding) => binding.binding === "FILES"
  );
  if (!bucket) {
    throw new Error(`No FILES r2_bucket for ${env} in wrangler.jsonc.`);
  }
  return bucket.bucket_name;
};
