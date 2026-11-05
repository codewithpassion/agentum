/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Product } from "@repo/protocol/releases";
import { file } from "bun";
import {
  fileKey,
  manifestKey,
  manifestSchema,
  PRODUCT_FILES,
  serializeManifest,
} from "../src/server/releases/manifest.ts";
import { publish } from "./publish-releases.ts";
import {
  artifactPath,
  assertCleanTree,
  type BuiltFile,
  bucketNameFor,
  buildManifest,
  buildVersion,
  parseArgs,
  sha256Hex,
  shouldSkip,
  type Uploader,
  type UploadSource,
  uploadPlan,
} from "./publish-releases-helpers.ts";

const VERSION = "0.1.0+abc1234";
const WRANGLER_JSONC = resolve(import.meta.dir, "../wrangler.jsonc");

const filesFor = (product: Product): BuiltFile[] =>
  PRODUCT_FILES[product].map((name) => ({
    bytes: new TextEncoder().encode(`${product}:${name}`),
    name,
  }));

describe("parseArgs", () => {
  test("reads --env and --allow-dirty", () => {
    expect(parseArgs(["--env", "staging"])).toEqual({
      allowDirty: false,
      dryRun: false,
      env: "staging",
    });
    expect(parseArgs(["--allow-dirty", "--env", "production"])).toEqual({
      allowDirty: true,
      dryRun: false,
      env: "production",
    });
  });

  test("refuses a missing env", () => {
    expect(() => parseArgs([])).toThrow("--env is required");
    expect(() => parseArgs(["--env"])).toThrow("--env is required");
  });

  test("refuses an env other than staging or production", () => {
    expect(() => parseArgs(["--env", "preview"])).toThrow(
      "--env must be staging or production"
    );
  });

  test("refuses an unknown argument", () => {
    expect(() => parseArgs(["--env", "staging", "--force"])).toThrow(
      'Unknown argument "--force"'
    );
  });
});

describe("buildVersion", () => {
  test("joins the package version and the short commit", () => {
    expect(buildVersion("0.1.0", "abc1234")).toBe(VERSION);
  });

  test("refuses a package version that is not semver", () => {
    expect(() => buildVersion("latest", "abc1234")).toThrow(
      "not a release version"
    );
  });
});

describe("sha256Hex", () => {
  test("matches the known digest of 'abc'", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("buildManifest", () => {
  test("records a sha256 and size for each file", () => {
    const manifest = buildManifest(
      "hm-computer",
      VERSION,
      filesFor("hm-computer")
    );
    expect(manifest.product).toBe("hm-computer");
    expect(manifest.version).toBe(VERSION);
    const [first] = filesFor("hm-computer");
    if (!first) {
      throw new Error("hm-computer ships no files");
    }
    expect(manifest.files[first.name]).toEqual({
      sha256: sha256Hex(first.bytes),
      size: first.bytes.byteLength,
    });
  });

  test("refuses a missing or extra file", () => {
    const files = filesFor("agentum");
    expect(() => buildManifest("agentum", VERSION, files.slice(1))).toThrow(
      "must ship"
    );
    expect(() =>
      buildManifest("agentum", VERSION, [
        ...files,
        { bytes: new Uint8Array(), name: "stray" },
      ])
    ).toThrow("must ship");
  });
});

describe("shouldSkip", () => {
  const manifestText = serializeManifest(
    buildManifest("agentum", VERSION, filesFor("agentum"))
  );

  test("skips when latest.json already names this version", () => {
    expect(shouldSkip(manifestText, VERSION)).toBe(true);
  });

  test("does not skip for another version, no file, or malformed text", () => {
    expect(shouldSkip(manifestText, "0.2.0+def5678")).toBe(false);
    expect(shouldSkip(null, VERSION)).toBe(false);
    expect(shouldSkip("{ not json", VERSION)).toBe(false);
    expect(shouldSkip('{"version": "0.1.0+abc1234"}', VERSION)).toBe(false);
  });
});

describe("assertCleanTree", () => {
  test("passes a clean tree", () => {
    expect(() => assertCleanTree("", false)).not.toThrow();
  });

  test("refuses a dirty tree unless allowed", () => {
    expect(() => assertCleanTree(" M apps/web/x.ts\n", false)).toThrow(
      "uncommitted changes"
    );
    expect(() => assertCleanTree(" M apps/web/x.ts\n", true)).not.toThrow();
  });
});

describe("uploadPlan", () => {
  test("uploads every binary, then latest.json last", () => {
    const manifest = buildManifest(
      "hm-computer",
      VERSION,
      filesFor("hm-computer")
    );
    const plan = uploadPlan("hm-computer", VERSION, manifest);
    expect(plan.map((item) => item.key)).toEqual([
      ...PRODUCT_FILES["hm-computer"].map((name) =>
        fileKey("hm-computer", VERSION, name)
      ),
      manifestKey("hm-computer"),
    ]);
  });

  test("binaries come from disk, latest.json from its body", () => {
    const manifest = buildManifest("agentum", VERSION, filesFor("agentum"));
    const [first, ...rest] = uploadPlan("agentum", VERSION, manifest);
    expect(first).toEqual({
      contentType: "application/octet-stream",
      filePath: artifactPath("agentum", "agentum-linux-x64"),
      key: fileKey("agentum", VERSION, "agentum-linux-x64"),
    });
    expect(rest.at(-1)).toEqual({
      body: serializeManifest(manifest),
      contentType: "application/json",
      key: manifestKey("agentum"),
    });
  });
});

describe("bucketNameFor", () => {
  test("reads the FILES bucket from the real wrangler.jsonc", async () => {
    const text = await file(WRANGLER_JSONC).text();
    expect(bucketNameFor("production", text)).toBe("agentum-v2-files");
    expect(bucketNameFor("staging", text)).toBe("agentum-v2-staging-files");
  });

  test("refuses a config with no FILES binding for the env", () => {
    const text = `{
      // comment
      "r2_buckets": [{ "binding": "OTHER", "bucket_name": "x" }],
      "env": { "staging": { "r2_buckets": [] } },
    }`;
    expect(() => bucketNameFor("production", text)).toThrow("FILES");
    expect(() => bucketNameFor("staging", text)).toThrow("FILES");
  });
});

interface Put {
  contentType: string;
  key: string;
  source: UploadSource;
}

/** An in-memory R2. `failOn` makes that key's put reject. */
const fakeUploader = (
  options: { latest?: Record<string, string>; failOn?: string } = {}
) => {
  const puts: Put[] = [];
  const store = new Map(Object.entries(options.latest ?? {}));
  const uploader: Uploader = {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, source, contentType) => {
      if (key === options.failOn) {
        return Promise.reject(new Error(`upload of ${key} failed`));
      }
      puts.push({ contentType, key, source });
      if ("body" in source) {
        store.set(key, source.body);
      }
      return Promise.resolve();
    },
  };
  return { puts, store, uploader };
};

const fakeBuild = () => {
  const requested: Product[] = [];
  const build = (_version: string, product: Product) => {
    requested.push(product);
    return Promise.resolve(filesFor(product));
  };
  return { build, requested };
};

const clean = () => ({ shortCommit: "abc1234", statusPorcelain: "" });
const quiet = () => undefined;

describe("publish", () => {
  test("uploads each product's binaries in order, with latest.json last", async () => {
    const { uploader, puts, store } = fakeUploader();
    const { build, requested } = fakeBuild();

    await publish({
      allowDirty: false,
      build,
      env: "staging",
      log: quiet,
      packageVersion: "0.1.0",
      readGit: clean,
      uploader,
    });

    expect(requested).toEqual(["agentum", "hm-computer", "agentum-rs"]);
    expect(puts.map((put) => put.key)).toEqual([
      ...PRODUCT_FILES.agentum.map((name) => fileKey("agentum", VERSION, name)),
      manifestKey("agentum"),
      ...PRODUCT_FILES["hm-computer"].map((name) =>
        fileKey("hm-computer", VERSION, name)
      ),
      manifestKey("hm-computer"),
      ...PRODUCT_FILES["agentum-rs"].map((name) =>
        fileKey("agentum-rs", VERSION, name)
      ),
      manifestKey("agentum-rs"),
    ]);
    const latest = store.get(manifestKey("hm-computer")) ?? "";
    expect(manifestSchema.parse(JSON.parse(latest)).version).toBe(VERSION);
  });

  test("skips a product whose latest.json already names this version", async () => {
    const live = serializeManifest(
      buildManifest("agentum", VERSION, filesFor("agentum"))
    );
    const { uploader, puts } = fakeUploader({
      latest: { [manifestKey("agentum")]: live },
    });
    const { build, requested } = fakeBuild();

    await publish({
      allowDirty: false,
      build,
      env: "production",
      log: quiet,
      packageVersion: "0.1.0",
      readGit: clean,
      uploader,
    });

    expect(requested).toEqual(["hm-computer", "agentum-rs"]);
    expect(puts.some((put) => put.key.includes("/agentum/"))).toBe(false);
    expect(puts).toHaveLength(
      PRODUCT_FILES["hm-computer"].length +
        PRODUCT_FILES["agentum-rs"].length +
        2
    );
  });

  test("uploads nothing when every product is already live", async () => {
    const latest = Object.fromEntries(
      (["agentum", "hm-computer", "agentum-rs"] as const).map((product) => [
        manifestKey(product),
        serializeManifest(buildManifest(product, VERSION, filesFor(product))),
      ])
    );
    const { uploader, puts } = fakeUploader({ latest });
    const { build, requested } = fakeBuild();

    await publish({
      allowDirty: false,
      build,
      env: "staging",
      log: quiet,
      packageVersion: "0.1.0",
      readGit: clean,
      uploader,
    });

    expect(requested).toEqual([]);
    expect(puts).toEqual([]);
  });

  test("refuses a dirty tree unless allowDirty", async () => {
    const dirty = () => ({
      shortCommit: "abc1234",
      statusPorcelain: " M x.ts\n",
    });
    const refused = fakeUploader();
    await expect(
      publish({
        allowDirty: false,
        build: fakeBuild().build,
        env: "staging",
        log: quiet,
        packageVersion: "0.1.0",
        readGit: dirty,
        uploader: refused.uploader,
      })
    ).rejects.toThrow("uncommitted changes");
    expect(refused.puts).toEqual([]);

    const allowed = fakeUploader();
    await publish({
      allowDirty: true,
      build: fakeBuild().build,
      env: "staging",
      log: quiet,
      packageVersion: "0.1.0",
      readGit: dirty,
      uploader: allowed.uploader,
    });
    expect(allowed.puts.length).toBeGreaterThan(0);
  });

  test("a failed binary upload leaves latest.json unwritten", async () => {
    const failing = fileKey("agentum", VERSION, "agentum-linux-arm64");
    const { uploader, puts, store } = fakeUploader({ failOn: failing });
    const { build } = fakeBuild();

    await expect(
      publish({
        allowDirty: false,
        build,
        env: "staging",
        log: quiet,
        packageVersion: "0.1.0",
        readGit: clean,
        uploader,
      })
    ).rejects.toThrow("failed");

    expect(puts.map((put) => put.key)).toEqual([
      fileKey("agentum", VERSION, "agentum-linux-x64"),
    ]);
    expect(store.has(manifestKey("agentum"))).toBe(false);
  });
});

test("dry run builds manifests without reading or writing the uploader", async () => {
  const logs: string[] = [];
  await publish({
    allowDirty: false,
    build: fakeBuild().build,
    dryRun: true,
    env: "staging",
    log: (message) => logs.push(message),
    packageVersion: "0.1.0",
    readGit: clean,
    uploader: {
      get: () => {
        throw new Error("network read");
      },
      put: () => {
        throw new Error("network write");
      },
    },
  });
  expect(logs.join("\n")).toContain("releases/agentum-rs/latest.json");
  expect(logs.join("\n")).toContain('"agentum-linux-arm64": { "sha256":');
});
