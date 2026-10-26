// A hash of the sources the sandbox helper is built from: every non-test file
// in `src/` except the generated bundle. The bundle script stamps the hash into
// the generated file and a test compares it, so a changed source with an old
// bundle is caught without depending on the bundler's exact output.
import { file, Glob } from "bun";

const SRC = new URL("../src/", import.meta.url).pathname;
const HEX_WIDTH = 2;
const EXCLUDED = /(\.test|\.generated|^testing)\.ts$/;

export const transferSourceHash = async (): Promise<string> => {
  const names = [...new Glob("*.ts").scanSync(SRC)]
    .filter((name) => !EXCLUDED.test(name))
    .sort();
  const parts = await Promise.all(
    names.map(
      async (name) => `${name}\u0000${await file(`${SRC}${name}`).text()}`
    )
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0001"))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(HEX_WIDTH, "0"))
    .join("");
};
