import { describe, expect, test } from "bun:test";
import { parse } from "acorn";
import type { SandboxFile } from "../skill-scripts/sandbox-port.ts";
import {
  APP_HARNESS,
  APP_SERVER_ENTRY,
  type AppModule,
  appModules,
  checkServerBundle,
  HARNESS_SOURCE,
} from "./modules.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const file = (path: string, text: string): SandboxFile => ({
  bytes: encode(text),
  path,
});
const VALID_ENTRY =
  "export default { fetch() { return new Response('ok'); } };";
const BAD_JSON = /^server\/bad\.json: invalid JSON/;
const BAD_JS_PARSE = /^server\/lib\/x\.js: /;
const BROKEN_ENTRY_PARSE = /^server\/index\.js: /;
const NO_DEFAULT_PROBLEM = /^server\/index\.js: no default export/;

const jsOf = (modules: Record<string, AppModule>, key: string): string => {
  const found = modules[key];
  return found !== undefined && "js" in found ? found.js : "";
};

describe("APP_SERVER_ENTRY and APP_HARNESS", () => {
  test("name the entry and the harness", () => {
    expect(APP_SERVER_ENTRY).toBe("server/index.js");
    expect(APP_HARNESS).toBe("__harness.js");
  });
});

describe("HARNESS_SOURCE", () => {
  test("parses as a module with a Harness class and a default export", () => {
    const program = parse(HARNESS_SOURCE, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    const types = program.body.map((node) => node.type);
    expect(types).toContain("ImportDeclaration");
    expect(types).toContain("ExportNamedDeclaration");
    expect(types).toContain("ExportDefaultDeclaration");
    expect(HARNESS_SOURCE).toContain(
      "export class Harness extends WorkerEntrypoint"
    );
    expect(HARNESS_SOURCE).toContain(
      "app.fetch(request, { ...this.env, HM: hm }, this.ctx)"
    );
  });
});

describe("appModules", () => {
  test("keys each file by its path and adds the harness", () => {
    const modules = appModules([
      file("server/index.js", VALID_ENTRY),
      file("server/lib/greet.js", "export const hi = 1;"),
    ]);
    expect(Object.keys(modules).sort()).toEqual([
      APP_HARNESS,
      "server/index.js",
      "server/lib/greet.js",
    ]);
    expect(jsOf(modules, APP_HARNESS)).toBe(HARNESS_SOURCE);
  });

  test("leaves JavaScript text untouched", () => {
    const text = "  export default   {fetch(){return 1}} // odd\n\n";
    const modules = appModules([
      file("server/index.js", text),
      file("server/x.mjs", text),
    ]);
    expect(jsOf(modules, "server/index.js")).toBe(text);
    expect(jsOf(modules, "server/x.mjs")).toBe(text);
  });

  test("maps .json to { json } with the parsed value", () => {
    const modules = appModules([file("server/config.json", '{"a":[1,2]}')]);
    expect(modules["server/config.json"]).toEqual({ json: { a: [1, 2] } });
  });

  test("maps other files to { data } with the same bytes", () => {
    const bytes = new Uint8Array([0, 255, 7, 42]);
    const modules = appModules([{ bytes, path: "server/img/logo.png" }]);
    const data = modules["server/img/logo.png"] as { data: ArrayBuffer };
    expect(new Uint8Array(data.data)).toEqual(bytes);
  });

  test("throws naming the file for invalid JSON", () => {
    expect(() => appModules([file("server/bad.json", "{nope")])).toThrow(
      BAD_JSON
    );
  });

  test("throws naming the file for a path not under server/", () => {
    expect(() => appModules([file("scripts/x.js", "export {};")])).toThrow(
      "scripts/x.js: not under server/"
    );
  });

  test("throws for TypeScript and JSX under server/", () => {
    for (const path of [
      "server/a.ts",
      "server/a.mts",
      "server/a.tsx",
      "server/a.jsx",
    ]) {
      expect(() => appModules([file(path, "const x = 1;")])).toThrow(
        `${path}: TypeScript and JSX are not supported in server/, pre-bundle to JavaScript`
      );
    }
  });
});

describe("checkServerBundle", () => {
  test("returns no problems for a valid bundle", () => {
    expect(
      checkServerBundle([
        file("server/index.js", VALID_ENTRY),
        file("server/lib/greet.js", "export const hi = 1;"),
        file("server/data.json", "{}"),
      ])
    ).toEqual([]);
  });

  test("reports a missing server/index.js", () => {
    expect(checkServerBundle([file("server/lib/x.js", "export {};")])).toEqual([
      "server/index.js: missing, an app needs a server entry",
    ]);
  });

  test("reports a JavaScript file acorn cannot parse, naming it", () => {
    const problems = checkServerBundle([
      file("server/index.js", VALID_ENTRY),
      file("server/lib/x.js", "const = ;"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(BAD_JS_PARSE);
  });

  test("reports a broken entry only as a parse problem", () => {
    const problems = checkServerBundle([
      file("server/index.js", "export default {"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(BROKEN_ENTRY_PARSE);
  });

  test("reports an entry without a default export", () => {
    const problems = checkServerBundle([
      file("server/index.js", "export const fetch = 1;"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(NO_DEFAULT_PROBLEM);
  });

  test("accepts a default export named through an export list", () => {
    expect(
      checkServerBundle([
        file(
          "server/index.js",
          "const app = { fetch() {} };\nexport { app as default };"
        ),
      ])
    ).toEqual([]);
  });

  test("accepts a default export that is not an object literal", () => {
    expect(
      checkServerBundle([
        file("server/index.js", "const app = {};\nexport default app;"),
      ])
    ).toEqual([]);
  });

  test("accepts object literals that have fetch under any spelling", () => {
    for (const body of [
      "{ fetch() { return 1; } }",
      "{ fetch: () => 1 }",
      "{ 'fetch': () => 1 }",
      "{ fetch }",
    ]) {
      expect(
        checkServerBundle([
          file(
            "server/index.js",
            `const fetch = () => 1;\nexport default ${body};`
          ),
        ])
      ).toEqual([]);
    }
  });

  test("accepts an object literal with a spread or computed key, since it cannot be proven missing", () => {
    expect(
      checkServerBundle([
        file(
          "server/index.js",
          "const base = {};\nexport default { ...base };"
        ),
      ])
    ).toEqual([]);
    expect(
      checkServerBundle([
        file("server/index.js", "const k = 'x';\nexport default { [k]: 1 };"),
      ])
    ).toEqual([]);
  });

  test("reports an object literal default export with no fetch", () => {
    for (const body of ["{}", "{ hello: 1 }", "{ fetched: () => 1 }"]) {
      const problems = checkServerBundle([
        file("server/index.js", `export default ${body};`),
      ]);
      expect(problems).toEqual([
        "server/index.js: default export is an object without fetch, add a fetch method",
      ]);
    }
  });

  test("reports a TypeScript file under server/ by its message", () => {
    expect(
      checkServerBundle([
        file("server/index.js", VALID_ENTRY),
        file("server/lib/x.ts", "const x: number = 1;"),
      ])
    ).toEqual([
      "server/lib/x.ts: TypeScript and JSX are not supported in server/, pre-bundle to JavaScript",
    ]);
  });

  test("reports invalid JSON, naming the file", () => {
    const problems = checkServerBundle([
      file("server/index.js", VALID_ENTRY),
      file("server/bad.json", "{nope"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(BAD_JSON);
  });

  test("reports a path outside server/", () => {
    expect(
      checkServerBundle([
        file("server/index.js", VALID_ENTRY),
        file("lib/y.js", "export {};"),
      ])
    ).toEqual(["lib/y.js: not under server/"]);
  });

  test("collects every problem in one pass", () => {
    const problems = checkServerBundle([
      file("server/lib/x.js", "const = ;"),
      file("server/bad.json", "{nope"),
    ]);
    expect(problems).toHaveLength(3);
  });
});
