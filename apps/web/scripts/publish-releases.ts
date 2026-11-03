#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Publishes the daemon and hm-computer binaries to the R2 bucket that the
 * release routes and install scripts read. Run it from apps/web.
 *
 *   bun scripts/publish-releases.ts --env staging
 *   bun scripts/publish-releases.ts --env production --allow-dirty
 *
 * Each product's binaries go under their version, then latest.json. A product
 * whose latest.json already names this version is skipped. The tests call
 * `publish` with a fake uploader and build, so nothing reaches R2 from there.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { file, spawnSync } from "bun";
import { z } from "zod";
import {
  manifestKey,
  PRODUCT_FILES,
  PRODUCTS,
  type Product,
} from "../src/server/releases/manifest.ts";
import {
  artifactDir,
  artifactPath,
  assertCleanTree,
  type BuiltFile,
  bucketNameFor,
  buildManifest,
  buildVersion,
  type PublishEnv,
  parseArgs,
  REPO_ROOT,
  shouldSkip,
  type Uploader,
  type UploadItem,
  type UploadSource,
  uploadPlan,
} from "./publish-releases-helpers.ts";

const WEB_DIR = resolve(import.meta.dir, "..");
const DAEMON_DIR = resolve(REPO_ROOT, "apps/daemon");
const COMPUTER_DIR = resolve(REPO_ROOT, "apps/computer");
const NOT_FOUND = /The specified key does not exist/;

export interface GitState {
  shortCommit: string;
  statusPorcelain: string;
}

export interface PublishOptions {
  allowDirty: boolean;
  build: (version: string, product: Product) => Promise<BuiltFile[]>;
  env: PublishEnv;
  log: (message: string) => void;
  /** apps/daemon/package.json's version, the first half of the release version. */
  packageVersion: string;
  readGit: () => GitState;
  uploader: Uploader;
}

const sourceOf = (item: UploadItem): UploadSource =>
  "filePath" in item ? { filePath: item.filePath } : { body: item.body };

export const publish = async ({
  env,
  allowDirty,
  packageVersion,
  uploader,
  build,
  readGit,
  log,
}: PublishOptions): Promise<void> => {
  const git = readGit();
  assertCleanTree(git.statusPorcelain, allowDirty);
  const version = buildVersion(packageVersion, git.shortCommit);
  log(`publishing ${version} to ${env}`);

  const live = await Promise.all(
    PRODUCTS.map(async (product) => ({
      product,
      text: await uploader.get(manifestKey(product)),
    }))
  );
  const pending: Product[] = [];
  for (const { product, text } of live) {
    if (shouldSkip(text, version)) {
      log(`${product}: ${version} is already live, skipping`);
    } else {
      pending.push(product);
    }
  }

  for (const product of pending) {
    // Sequential on purpose: a product's binaries must all land before its latest.json.
    // biome-ignore lint/performance/noAwaitInLoops: uploads run in order
    const files = await build(version, product);
    const manifest = buildManifest(product, version, files);
    for (const item of uploadPlan(product, version, manifest)) {
      log(`put ${item.key}`);
      // biome-ignore lint/performance/noAwaitInLoops: latest.json must come last
      await uploader.put(item.key, sourceOf(item), item.contentType);
    }
    log(`${product}: published ${version}`);
  }
};

// Side effects: the real build, git and wrangler.

const logLine = (message: string) =>
  console.log(`[publish-releases] ${message}`);

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const run = (
  command: string[],
  cwd: string,
  env: Record<string, string> = {}
): void => {
  const result = spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}`);
  }
};

const buildDaemon = (version: string): void => {
  mkdirSync(artifactDir("agentum"), { recursive: true });
  for (const name of PRODUCT_FILES.agentum) {
    // agentum-linux-x64 is built with --target=bun-linux-x64.
    const target = name.replace("agentum-", "bun-");
    run(
      [
        "bun",
        "build",
        "--compile",
        "--minify",
        `--target=${target}`,
        "src/main.ts",
        "--outfile",
        artifactPath("agentum", name),
        "--define",
        `process.env.HM_DAEMON_VERSION=${JSON.stringify(version)}`,
      ],
      DAEMON_DIR
    );
  }
};

const buildComputer = (version: string): void => {
  run(["bash", join(COMPUTER_DIR, "scripts/build-all.sh")], COMPUTER_DIR, {
    HM_COMPUTER_VERSION: version,
  });
};

const BUILDERS: Record<Product, (version: string) => void> = {
  agentum: buildDaemon,
  "hm-computer": buildComputer,
};

const buildProduct = (
  version: string,
  product: Product
): Promise<BuiltFile[]> => {
  BUILDERS[product](version);
  return Promise.all(
    PRODUCT_FILES[product].map(async (name) => ({
      bytes: await file(artifactPath(product, name)).bytes(),
      name,
    }))
  );
};

const git = (args: string[]): string => {
  const result = spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decode(result.stderr).trim()}`
    );
  }
  return decode(result.stdout);
};

const readGitState = (): GitState => ({
  shortCommit: git(["rev-parse", "--short", "HEAD"]).trim(),
  statusPorcelain: git(["status", "--porcelain"]),
});

/** Runs `wrangler r2 object ...` in apps/web. Staging needs its env for the bucket. */
const wranglerR2 = (args: string[], env: PublishEnv) =>
  spawnSync(
    [
      "bun",
      "x",
      "wrangler",
      "r2",
      "object",
      ...args,
      "--remote",
      ...(env === "staging" ? ["--env", "staging"] : []),
    ],
    { cwd: WEB_DIR, stderr: "pipe", stdout: "pipe" }
  );

/** Writes a body to a file, since `wrangler r2 object put` reads from disk. */
const stageBody = (dir: string, key: string, body: string): string => {
  const path = join(dir, basename(key));
  writeFileSync(path, body);
  return path;
};

const wranglerUploader = (
  bucket: string,
  env: PublishEnv,
  tempDir: string
): Uploader => ({
  get: (key) => {
    const result = wranglerR2(["get", `${bucket}/${key}`, "--pipe"], env);
    if (result.exitCode === 0) {
      return Promise.resolve(decode(result.stdout));
    }
    const stderr = decode(result.stderr);
    if (NOT_FOUND.test(stderr)) {
      return Promise.resolve(null);
    }
    throw new Error(
      `get ${key} failed (exit ${result.exitCode}): ${stderr.trim()}`
    );
  },
  put: (key, source, contentType) => {
    const filePath =
      "body" in source ? stageBody(tempDir, key, source.body) : source.filePath;
    const result = wranglerR2(
      [
        "put",
        `${bucket}/${key}`,
        "--file",
        filePath,
        "--content-type",
        contentType,
      ],
      env
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `put ${key} failed (exit ${result.exitCode}): ${decode(result.stderr).trim()}`
      );
    }
    return Promise.resolve();
  },
});

if (import.meta.main) {
  const { env, allowDirty } = parseArgs(process.argv.slice(2));
  const bucket = bucketNameFor(
    env,
    await file(join(WEB_DIR, "wrangler.jsonc")).text()
  );
  const packageVersion = z
    .object({ version: z.string() })
    .parse(await file(join(DAEMON_DIR, "package.json")).json()).version;
  const tempDir = mkdtempSync(join(tmpdir(), "hm-publish-"));
  try {
    await publish({
      allowDirty,
      build: buildProduct,
      env,
      log: logLine,
      packageVersion,
      readGit: readGitState,
      uploader: wranglerUploader(bucket, env, tempDir),
    });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}
