import { expect, test } from "bun:test";
import { join } from "node:path";
import { file, Glob } from "bun";

const SRC_ROOT = join(import.meta.dir, "..", "..");
// Built from parts so this file does not contain the path it forbids.
const FORBIDDEN = ["/api", "public", "newsletters"].join("/");

test("no source file under apps/web/src calls the public newsletters API", async () => {
  const glob = new Glob("**/*.{ts,tsx}");
  const offenders: string[] = [];
  let scanned = 0;
  for await (const relative of glob.scan({ cwd: SRC_ROOT })) {
    const filePath = join(SRC_ROOT, relative);
    if (filePath === import.meta.path) {
      continue;
    }
    scanned += 1;
    const text = await file(filePath).text();
    if (text.includes(FORBIDDEN)) {
      offenders.push(relative);
    }
  }
  // Guard against a glob that matches nothing and passes trivially.
  expect(scanned).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
