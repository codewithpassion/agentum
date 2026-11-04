import { expect, test } from "bun:test";
import { file } from "bun";

const COMPOSITION_EXPORTS = /compose\([\s\S]*?\.exports/;

for (const path of [
  "../../server.ts",
  "../pi-run.ts",
  "../managed-poller.ts",
  "../linux-vm/vm-session.ts",
  "../guest-run.ts",
  "../script-host.ts",
]) {
  test(`${path} passes exports to composition`, async () => {
    const text = await file(new URL(path, import.meta.url)).text();
    expect(text).toMatch(COMPOSITION_EXPORTS);
  });
}
