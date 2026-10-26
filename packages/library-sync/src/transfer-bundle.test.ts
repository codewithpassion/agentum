import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, write } from "bun";
import { transferSourceHash } from "../scripts/transfer-sources.ts";
import {
  TRANSFER_HELPER_SOURCE,
  TRANSFER_SOURCE_HASH,
} from "./transfer-bundle.generated.ts";

test("the committed bundle matches the helper sources (run `bun run bundle` in packages/library-sync)", async () => {
  expect(TRANSFER_SOURCE_HASH).toBe(await transferSourceHash());
});

test("the bundle is one script with no workspace imports", () => {
  expect(TRANSFER_HELPER_SOURCE.length).toBeGreaterThan(1000);
  expect(TRANSFER_HELPER_SOURCE).not.toContain("@repo/");
  expect(TRANSFER_HELPER_SOURCE).not.toContain("workspace:");
});

test("the bundle runs on its own, and without a token it says what is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "transfer-bundle-"));
  try {
    const script = join(dir, "library.js");
    await write(script, TRANSFER_HELPER_SOURCE);
    const result = spawnSync(
      ["bun", script, "pull", "agents/x", "--url", "http://127.0.0.1:1"],
      { env: { PATH: process.env.PATH ?? "" } }
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("HM_LIBRARY_TOKEN");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
