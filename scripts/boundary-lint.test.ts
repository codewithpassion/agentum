import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "bun";
import { scanBundleText, scanText } from "./boundary-lint";

const SCRIPT = join(import.meta.dir, "boundary-lint.ts");
const WORKTREE_ROOT = resolve(import.meta.dir, "..");
const RULE_SCHEMA = "@repo/db/schema import outside services";
const RULE_SERVER = "server import in client code";
const RULE_BUNDLE = "drizzle in client bundle";

const fixtures: string[] = [];

/** Build a throwaway repo from a map of relative path to file content. */
const makeFixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "boundary-lint-"));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
};

const runLint = (cwd: string) =>
  spawnSync([process.execPath, SCRIPT], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

afterAll(() => {
  for (const dir of fixtures) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scanText: schema imports (rule 1)", () => {
  const schemaImport = 'import { runs } from "@repo/db/schema/runs"\n';

  test("FLAGS a static schema import in an app file", () => {
    const hits = scanText("apps/web/src/server/x.ts", schemaImport);
    expect(hits.map((h) => h.rule)).toEqual([RULE_SCHEMA]);
    expect(hits[0]?.line).toBe(1);
  });

  test("FLAGS a bare side-effect schema import", () => {
    const hits = scanText(
      "apps/web/src/server/x.ts",
      'import "@repo/db/schema/runs"\n'
    );
    expect(hits.map((h) => h.rule)).toEqual([RULE_SCHEMA]);
  });

  test("FLAGS a dynamic schema import", () => {
    const text = 'export const load = () => import("@repo/db/schema/runs")\n';
    expect(
      scanText("packages/workflows/src/y.ts", text).map((h) => h.rule)
    ).toEqual([RULE_SCHEMA]);
  });

  test("FLAGS a require of a schema module", () => {
    const text = 'const runs = require("@repo/db/schema/runs")\n';
    expect(scanText("scripts/z.ts", text).map((h) => h.rule)).toEqual([
      RULE_SCHEMA,
    ]);
  });

  test("FLAGS a schema import whose braces span several lines", () => {
    const text =
      'import {\n  runs,\n  events,\n} from "@repo/db/schema/runs"\n';
    const hits = scanText("apps/web/src/server/x.ts", text);
    expect(hits.map((h) => h.line)).toEqual([4]);
  });

  test("PASSES schema imports inside packages/services and packages/db", () => {
    expect(scanText("packages/services/src/x.ts", schemaImport)).toEqual([]);
    expect(scanText("packages/db/src/runs.ts", schemaImport)).toEqual([]);
  });

  test("PASSES a non-schema @repo/db import", () => {
    expect(
      scanText(
        "apps/web/src/server/x.ts",
        'import { atomic } from "@repo/db/atomic"\n'
      )
    ).toEqual([]);
  });

  test("does NOT flag a schema import that sits in a comment line", () => {
    const text = [
      '// import { runs } from "@repo/db/schema/runs"',
      ' * import("@repo/db/schema/runs")',
      '/* require("@repo/db/schema/runs") */',
      "export const ok = 1",
    ].join("\n");
    expect(scanText("apps/web/src/server/x.ts", text)).toEqual([]);
  });
});

describe("scanText: server imports from client code (rule 2)", () => {
  test("FLAGS a #/server import in a route", () => {
    const text = 'import { trpc } from "#/server/trpc/router"\n';
    const hits = scanText("apps/web/src/routes/index.tsx", text);
    expect(hits.map((h) => h.rule)).toEqual([RULE_SERVER]);
  });

  test("FLAGS a relative import with a server segment from a component", () => {
    const text = 'import { y } from "../../server/trpc/y"\n';
    const hits = scanText("apps/web/src/components/panel.tsx", text);
    expect(hits.map((h) => h.rule)).toEqual([RULE_SERVER]);
  });

  test("FLAGS a same-folder ./server import from a route", () => {
    const text = 'import { x } from "./server/x"\n';
    expect(
      scanText("apps/web/src/routes/a/b.tsx", text).map((h) => h.rule)
    ).toEqual([RULE_SERVER]);
  });

  test("FLAGS a dynamic server import from a component", () => {
    const text = 'const mod = await import("#/server/trpc/router")\n';
    expect(
      scanText("apps/web/src/components/c.tsx", text).map((h) => h.rule)
    ).toEqual([RULE_SERVER]);
  });

  test("PASSES client imports and server-looking names that are not a server segment", () => {
    const text = [
      'import { getTrpc } from "#/integrations/trpc/client"',
      'import { cn } from "../lib/utils"',
      'import { s } from "../serverless-things"',
      "export const ok = 1",
    ].join("\n");
    expect(scanText("apps/web/src/routes/index.tsx", text)).toEqual([]);
  });

  test("PASSES a server import outside routes and components", () => {
    const text = 'import { trpc } from "#/server/trpc/router"\n';
    expect(scanText("apps/web/src/server/x.ts", text)).toEqual([]);
  });

  test("does NOT flag a server import that sits in a comment line", () => {
    const text = '// import { trpc } from "#/server/trpc/router"\n';
    expect(scanText("apps/web/src/routes/index.tsx", text)).toEqual([]);
  });

  test("applies rule 1 to a route file as well", () => {
    const text = 'import { runs } from "@repo/db/schema/runs"\n';
    expect(
      scanText("apps/web/src/routes/index.tsx", text).map((h) => h.rule)
    ).toEqual([RULE_SCHEMA]);
  });
});

describe("scanBundleText: drizzle in client bundle (rule 3)", () => {
  test("FLAGS drizzle in a bundle file, case-insensitively, with its real line", () => {
    const text = "var a = 1;\nvar b = Drizzle_ORM;\n";
    const hits = scanBundleText("apps/web/dist/client/a.js", text);
    expect(hits.map((h) => h.rule)).toEqual([RULE_BUNDLE]);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.col).toBe(9);
  });

  test("PASSES a bundle file without drizzle", () => {
    expect(scanBundleText("apps/web/dist/client/a.js", "var a = 1;")).toEqual(
      []
    );
  });
});

describe("scanRepo CLI", () => {
  const CLEAN_FILES = {
    "apps/web/dist/client/a.js": "var a = 1;\n",
    "apps/web/src/routes/index.tsx":
      'import { getTrpc } from "#/integrations/trpc/client"\nexport const r = 1\n',
    "apps/web/src/server/x.ts":
      'import { atomic } from "@repo/db/atomic"\nexport const x = 1\n',
    "packages/services/src/runs.ts": 'export const s = "ok"\n',
  };

  test("exits 0 and prints clean for a clean fixture", () => {
    const result = runLint(makeFixture(CLEAN_FILES));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("clean");
  });

  test("exits 1 and names the file when an app server file imports a schema", () => {
    const root = makeFixture({
      ...CLEAN_FILES,
      "apps/web/src/server/x.ts":
        'import { runs } from "@repo/db/schema/runs";\n',
    });
    const result = runLint(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("apps/web/src/server/x.ts:1:");
    expect(result.stderr.toString()).toContain(RULE_SCHEMA);
  });

  test("exits 1 and names the file when a planted client bundle mentions drizzle", () => {
    const root = makeFixture({
      ...CLEAN_FILES,
      "apps/web/dist/client/a.js": 'var d = "drizzle-orm/d1";\n',
    });
    const result = runLint(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("apps/web/dist/client/a.js");
    expect(result.stderr.toString()).toContain(RULE_BUNDLE);
  });

  test("exits 0 when packages/services imports a schema", () => {
    const root = makeFixture({
      ...CLEAN_FILES,
      "packages/services/src/runs.ts":
        'import { runs } from "@repo/db/schema/runs"\n',
    });
    expect(runLint(root).exitCode).toBe(0);
  });

  test("exits 0 when the repo has no dist/client directory", () => {
    const root = makeFixture({
      "apps/web/src/server/x.ts": "export const x = 1\n",
    });
    expect(runLint(root).exitCode).toBe(0);
  });

  test("the real worktree passes the lint", () => {
    const result = runLint(WORKTREE_ROOT);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
