// The contract between the publish script, the release routes and the install
// scripts: which products exist, what their files are called, where they live
// in R2 and what `latest.json` looks like. Pure, so a script can import it.

import { PRODUCTS, type Product } from "@repo/protocol/releases";
import { z } from "zod";

/** Every release key starts with this. Nothing else writes under it. */
export const RELEASE_PREFIX = "releases/";

/** The files each product ships. The install scripts pick one by OS and architecture. */
export const PRODUCT_FILES: Record<Product, readonly string[]> = {
  agentum: ["agentum-linux-x64", "agentum-linux-arm64"],
  "agentum-rs": ["agentum-linux-x64", "agentum-linux-arm64"],
  "hm-computer": [
    "hm-computer_linux_amd64",
    "hm-computer_linux_arm64",
    "hm-computer_darwin_amd64",
    "hm-computer_darwin_arm64",
  ],
};

/** `<package version>+<short commit>`, with an optional pre-release tag. */
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const isProduct = (value: string): value is Product =>
  (PRODUCTS as readonly string[]).includes(value);

export const isVersion = (value: string): boolean =>
  VERSION_PATTERN.test(value);

/** `<package version>+<short commit>`, the string embedded in a build. */
export const releaseVersion = (
  packageVersion: string,
  shortCommit: string
): string => `${packageVersion}+${shortCommit}`;

/** The R2 key of one release file. */
export const fileKey = (
  product: Product,
  version: string,
  file: string
): string => `${RELEASE_PREFIX}${product}/${version}/${file}`;

/** The R2 key of a product's `latest.json`. */
export const manifestKey = (product: Product): string =>
  `${RELEASE_PREFIX}${product}/latest.json`;

export const manifestSchema = z.strictObject({
  files: z.record(
    z.string().min(1),
    z.strictObject({
      sha256: z.string().regex(SHA256_PATTERN),
      size: z.number().int().nonnegative(),
    })
  ),
  product: z.enum(PRODUCTS),
  version: z.string().regex(VERSION_PATTERN),
});
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * The text of `latest.json`. One key per line, so the install scripts can read
 * it with `sed` and no `jq`: `"version": "..."` on its own line, and one line
 * per file, `"<name>": { "sha256": "...", "size": N }`.
 */
export const serializeManifest = (manifest: Manifest): string => {
  const files = Object.entries(manifest.files).map(
    ([name, { sha256, size }]) =>
      `    ${JSON.stringify(name)}: { "sha256": ${JSON.stringify(sha256)}, "size": ${size} }`
  );
  return [
    "{",
    `  "product": ${JSON.stringify(manifest.product)},`,
    `  "version": ${JSON.stringify(manifest.version)},`,
    '  "files": {',
    files.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
};

/**
 * Whether `product`/`version`/`file` names a file the publish script writes.
 * The route serves only names this accepts, so a request path can't reach
 * another key.
 */
export const isReleaseFile = (
  product: string,
  version: string,
  file: string
): boolean =>
  isProduct(product) &&
  isVersion(version) &&
  PRODUCT_FILES[product].includes(file);
