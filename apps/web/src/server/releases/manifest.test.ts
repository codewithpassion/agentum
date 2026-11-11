import { describe, expect, test } from "bun:test";
import { PRODUCTS } from "@repo/protocol/releases";
import {
  fileKey,
  isReleaseFile,
  type Manifest,
  manifestKey,
  manifestSchema,
  PRODUCT_FILES,
  releaseVersion,
  serializeManifest,
} from "./manifest.ts";

const VERSION = "1.2.3+abc1234";
const HASH = "a".repeat(64);

const manifestFor = (): Manifest => ({
  files: Object.fromEntries(
    PRODUCT_FILES["agentum-rs"].map((name, index) => [
      name,
      { sha256: HASH, size: index + 1 },
    ])
  ),
  product: "agentum-rs",
  version: VERSION,
});

describe("release contract", () => {
  test("releaseVersion joins the package version and the short commit", () => {
    expect(releaseVersion("1.2.3", "abc1234")).toBe(VERSION);
  });

  test("fileKey and manifestKey live under releases/<product>", () => {
    expect(fileKey("agentum-rs", VERSION, "agentum-linux-x64")).toBe(
      "releases/agentum-rs/1.2.3+abc1234/agentum-linux-x64"
    );
    expect(manifestKey("agentum-rs")).toBe("releases/agentum-rs/latest.json");
  });

  test("isReleaseFile accepts a file the product ships", () => {
    expect(isReleaseFile("agentum-rs", VERSION, "agentum-linux-x64")).toBe(
      true
    );
    expect(isReleaseFile("agentum-rs", VERSION, "agentum-linux-arm64")).toBe(
      true
    );
  });

  test("isReleaseFile rejects path tricks", () => {
    expect(isReleaseFile("agentum-rs", VERSION, "../latest.json")).toBe(false);
    expect(isReleaseFile("agentum-rs", VERSION, "agentum-linux-x64/../x")).toBe(
      false
    );
  });

  test("isReleaseFile rejects an unknown product, file or version", () => {
    expect(isReleaseFile("other", VERSION, "agentum-linux-x64")).toBe(false);
    expect(isReleaseFile("agentum-rs", VERSION, "agentum")).toBe(false);
    expect(
      isReleaseFile("agentum-rs", "1.2+abc1234", "agentum-linux-x64")
    ).toBe(false);
  });

  test("the retired products are not products", () => {
    expect(PRODUCTS).toEqual(["agentum-rs"]);
    expect(isReleaseFile("agentum", VERSION, "agentum-linux-x64")).toBe(false);
    expect(
      isReleaseFile("hm-computer", VERSION, "hm-computer_linux_amd64")
    ).toBe(false);
  });

  test("serializeManifest parses as JSON and satisfies the schema", () => {
    const manifest = manifestFor();
    expect(
      manifestSchema.parse(JSON.parse(serializeManifest(manifest)))
    ).toEqual(manifest);
  });

  test("serializeManifest puts version on one line and each file on its own line", () => {
    const lines = serializeManifest(manifestFor()).split("\n");
    expect(lines.filter((line) => line.includes('"version"'))).toEqual([
      `  "version": "${VERSION}",`,
    ]);
    expect(lines.filter((line) => line.includes('"sha256"'))).toHaveLength(
      PRODUCT_FILES["agentum-rs"].length
    );
  });
});
