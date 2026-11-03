/**
 * boundary-lint: a regex backstop for Agentum's import boundaries (see CLAUDE.md,
 * "Database" and "Services and tRPC"). It is a line-oriented scanner, not an AST analyzer.
 * It reads only import specifiers: static `from "..."`, bare `import "..."`, dynamic
 * `import("...")` and `require("...")`.
 *
 * Rules:
 *   - "@repo/db/schema import outside services": only packages/services (and packages/db)
 *     may import the table modules.
 *   - "server import in client code": files under apps/web/src/routes and
 *     apps/web/src/components may not import `#/server` or a relative path with a `server`
 *     segment.
 *   - "drizzle in client bundle": no file under apps/web/dist/client may mention drizzle.
 *     The check is skipped when that directory does not exist.
 *
 * Comment lines (starting with //, * or a block-comment opener) are skipped, so prose that
 * mentions an import does not count.
 *
 * Exits nonzero with `file:line:col [rule] text` for every hit; prints a clean line and
 * exits 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Violation {
  col: number;
  file: string;
  line: number;
  rule: string;
  text: string;
}

interface ImportRule {
  appliesTo: (file: string) => boolean;
  forbids: (specifier: string) => boolean;
  rule: string;
}

const BUNDLE_RULE = "drizzle in client bundle";
const SCHEMA_PREFIX = "@repo/db/schema/";
const EXCERPT_LIMIT = 200;

const SEPARATOR_RE = /[\\/]/;

const normalize = (path: string): string => path.split(SEPARATOR_RE).join("/");

const isServicesOrDb = (file: string): boolean =>
  file.startsWith("packages/db/") || file.startsWith("packages/services/");

const isClientSource = (file: string): boolean =>
  file.startsWith("apps/web/src/routes/") ||
  file.startsWith("apps/web/src/components/");

const isServerSpecifier = (specifier: string): boolean =>
  specifier.startsWith("#/server") ||
  ((specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.split("/").includes("server"));

export const IMPORT_RULES: ImportRule[] = [
  {
    appliesTo: (file) => !isServicesOrDb(file),
    forbids: (specifier) => specifier.startsWith(SCHEMA_PREFIX),
    rule: "@repo/db/schema import outside services",
  },
  {
    appliesTo: isClientSource,
    forbids: isServerSpecifier,
    rule: "server import in client code",
  },
];

/**
 * Matches the specifier string of an import, dynamic import or require. Group 2 is the
 * specifier without its quotes.
 */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]*)\1/g;

const DRIZZLE_RE = /drizzle/i;

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
};

const excerpt = (line: string): string => line.trim().slice(0, EXCERPT_LIMIT);

/** 1-based line and column of a character index in `text`. */
const locate = (text: string, index: number): { line: number; col: number } => {
  const before = text.slice(0, index);
  return {
    col: index - before.lastIndexOf("\n"),
    line: before.split("\n").length,
  };
};

/** Scan one source file's text against the import rules that apply to its path. */
export const scanText = (file: string, text: string): Violation[] => {
  const path = normalize(file);
  const rules = IMPORT_RULES.filter((rule) => rule.appliesTo(path));
  if (rules.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  const code = lines
    .map((line) => (isCommentLine(line) ? "" : line))
    .join("\n");
  const out: Violation[] = [];
  for (const match of code.matchAll(SPECIFIER_RE)) {
    const specifier = match[2] ?? "";
    const { line, col } = locate(code, match.index);
    for (const { rule, forbids } of rules) {
      if (forbids(specifier)) {
        out.push({
          col,
          file: path,
          line,
          rule,
          text: excerpt(lines[line - 1] ?? ""),
        });
      }
    }
  }
  return out;
};

/** Scan one file from the client bundle for the drizzle rule. */
export const scanBundleText = (file: string, text: string): Violation[] => {
  const path = normalize(file);
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = DRIZZLE_RE.exec(line);
    if (match) {
      out.push({
        col: match.index + 1,
        file: path,
        line: index + 1,
        rule: BUNDLE_RULE,
        text: excerpt(line),
      });
    }
  }
  return out;
};

const SOURCE_ROOTS = ["apps", "packages", "scripts"];
const CLIENT_BUNDLE = join("apps", "web", "dist", "client");
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".turbo",
  ".output",
]);

const isScannable = (relPath: string): boolean => {
  const path = normalize(relPath);
  if (
    path.endsWith(".d.ts") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx")
  ) {
    return false;
  }
  return path.endsWith(".ts") || path.endsWith(".tsx");
};

/** Every file under `dir` (relative to `cwd`), skipping the named directories. */
const listFiles = (
  dir: string,
  cwd: string,
  skipDirs: ReadonlySet<string>
): string[] => {
  const absolute = join(cwd, dir);
  if (!existsSync(absolute)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        out.push(...listFiles(rel, cwd, skipDirs));
      }
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
};

/** Scan the whole repo under `cwd`: the source roots, then the client bundle if present. */
export const scanRepo = (cwd: string = process.cwd()): Violation[] => {
  const sources = SOURCE_ROOTS.flatMap((root) =>
    listFiles(root, cwd, EXCLUDED_DIRS)
  )
    .filter(isScannable)
    .flatMap((file) => scanText(file, readFileSync(join(cwd, file), "utf8")));
  const bundle = listFiles(CLIENT_BUNDLE, cwd, new Set()).flatMap((file) =>
    scanBundleText(file, readFileSync(join(cwd, file), "utf8"))
  );
  return [...sources, ...bundle];
};

if (import.meta.main) {
  const violations = scanRepo();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}:${v.col} [${v.rule}] ${v.text}`);
    }
    console.error(`\nboundary-lint: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("boundary-lint: clean");
}
