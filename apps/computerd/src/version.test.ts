import { describe, expect, test } from "bun:test";
import { VERSION } from "./version";

describe("VERSION", () => {
  test("matches the package version the image is built from", async () => {
    const manifest = (await Bun.file(
      new URL("../package.json", import.meta.url)
    ).json()) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });
});
