/// <reference types="bun" />

import { expect, test } from "bun:test";
import { file, JSONC } from "bun";

interface Section {
  compatibility_flags?: string[];
}
interface Config extends Section {
  env: { staging: Section & { previews: Section } };
}

test("fetch is strictly public at the top level, in staging and in previews", async () => {
  const config = JSONC.parse(
    await file(new URL("../../wrangler.jsonc", import.meta.url)).text()
  ) as Config;
  for (const section of [
    config,
    config.env.staging,
    config.env.staging.previews,
  ]) {
    expect(section.compatibility_flags).toContain(
      "global_fetch_strictly_public"
    );
  }
});
