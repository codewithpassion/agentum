import { describe, expect, test } from "bun:test";
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
    PRODUCT_FILES["hm-computer"].map((name, index) => [
      name,
      { sha256: HASH, size: index + 1 },
    ])
  ),
  product: "hm-computer",
  version: VERSION,
});

describe("release contract", () => {
  test("releaseVersion joins the package version and the short commit", () => {
    expect(releaseVersion("1.2.3", "abc1234")).toBe(VERSION);
  });

  test("fileKey and manifestKey live under releases/<product>", () => {
    expect(fileKey("harbourmaster", VERSION, "harbourmaster-linux-x64")).toBe(
      "releases/harbourmaster/1.2.3+abc1234/harbourmaster-linux-x64"
    );
    expect(manifestKey("hm-computer")).toBe("releases/hm-computer/latest.json");
  });

  test("isReleaseFile accepts a file the product ships", () => {
    expect(
      isReleaseFile("harbourmaster", VERSION, "harbourmaster-linux-x64")
    ).toBe(true);
    expect(
      isReleaseFile("hm-computer", VERSION, "hm-computer_linux_arm64")
    ).toBe(true);
  });

  test("isReleaseFile rejects path tricks", () => {
    expect(isReleaseFile("harbourmaster", VERSION, "../latest.json")).toBe(
      false
    );
    expect(
      isReleaseFile("harbourmaster", VERSION, "harbourmaster-linux-x64/../x")
    ).toBe(false);
  });

  test("isReleaseFile rejects an unknown product, file or version", () => {
    expect(isReleaseFile("other", VERSION, "harbourmaster-linux-x64")).toBe(
      false
    );
    expect(isReleaseFile("harbourmaster", VERSION, "harbourmaster")).toBe(
      false
    );
    expect(
      isReleaseFile("harbourmaster", "1.2+abc1234", "harbourmaster-linux-x64")
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
      PRODUCT_FILES["hm-computer"].length
    );
  });
});
