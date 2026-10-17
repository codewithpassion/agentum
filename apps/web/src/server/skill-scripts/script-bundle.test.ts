import { describe, expect, test } from "bun:test";
import { buildModules, ENTRY_FUNCTION } from "./script-bundle.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const file = (path: string, text: string) => ({ bytes: encode(text), path });
const jsOf = (
  modules: ReturnType<typeof buildModules>,
  key: string
): string => {
  const found = modules[key];
  return found !== undefined && "js" in found ? found.js : "";
};

describe("buildModules", () => {
  test("strips TypeScript and keys modules by skill-relative path", () => {
    const modules = buildModules(
      [
        file("scripts/hello.ts", "const n: number = 1;\nconsole.log(n);"),
        file("scripts/lib.ts", "export const x: string = 'a';"),
      ],
      "scripts/hello.ts"
    );
    expect(Object.keys(modules).sort()).toEqual([
      "scripts/hello.ts",
      "scripts/lib.ts",
    ]);
    expect(jsOf(modules, "scripts/lib.ts")).not.toContain(": string");
  });

  test("wraps the entry in a function and keeps its imports on top", () => {
    const modules = buildModules(
      [
        file(
          "scripts/hello.ts",
          "import { x } from './lib.ts';\nconst r = await fetch('https://example.com');\nconsole.log(x, r.status);"
        ),
      ],
      "scripts/hello.ts"
    );
    const code = jsOf(modules, "scripts/hello.ts");
    expect(code.indexOf("import")).toBeLessThan(code.indexOf(ENTRY_FUNCTION));
    expect(code).toContain(`export default async function ${ENTRY_FUNCTION}()`);
    expect(code.indexOf("await fetch")).toBeGreaterThan(
      code.indexOf(ENTRY_FUNCTION)
    );
  });

  test("turns a named export of the entry into a plain declaration", () => {
    const modules = buildModules(
      [file("a.ts", "export const x = 2;\nconsole.log(x);")],
      "a.ts"
    );
    const code = jsOf(modules, "a.ts");
    expect(code).toContain("const x = 2;");
    expect(code).not.toContain("export const");
  });

  test("awaits a top-level call so a script that starts its work with main() is waited for", () => {
    const modules = buildModules(
      [
        file(
          "a.ts",
          "async function main() { console.log(1); }\nmain().catch(console.error);\nconst x = 1;\nx;"
        ),
      ],
      "a.ts"
    );
    const code = jsOf(modules, "a.ts");
    expect(code).toContain("await main().catch(console.error);");
    expect(code).not.toContain("await const");
    expect(code).not.toContain("await x;");
  });

  test("refuses a default export in the entry", () => {
    expect(() =>
      buildModules([file("a.ts", "export default 1;")], "a.ts")
    ).toThrow("a.ts");
  });

  test("names the file that does not parse", () => {
    expect(() =>
      buildModules([file("scripts/a.ts", "const = ;")], "scripts/a.ts")
    ).toThrow("scripts/a.ts");
  });

  test("places JSON as a JSON module and other files as data", () => {
    const modules = buildModules(
      [
        file("a.ts", "console.log(1)"),
        file("d.json", '{"k":1}'),
        file("n.md", "hi"),
      ],
      "a.ts"
    );
    expect(modules["d.json"]).toEqual({ json: { k: 1 } });
    const note = modules["n.md"];
    expect(note).toEqual({ data: expect.any(ArrayBuffer) });
  });
});
