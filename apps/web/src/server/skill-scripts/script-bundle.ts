/**
 * Turns a skill's files into the modules of a Dynamic Worker. TypeScript is
 * stripped to JavaScript, and the entry script is wrapped in a function: a
 * Worker may not do I/O while a module loads, and a script's top-level
 * `await fetch(...)` is I/O.
 */
import { parse } from "acorn";
import { transform } from "sucrase";
import type { SandboxFile } from "./sandbox-port.ts";

/** What a Worker Loader accepts for one module, the part of it this file uses. */
export type BundleModule =
  | { data: ArrayBuffer }
  | { js: string }
  | { json: unknown };

export const ENTRY_FUNCTION = "__skillMain";

const decoder = new TextDecoder();
const TYPESCRIPT = /\.(?:ts|mts|tsx)$/;
const JAVASCRIPT = /\.(?:js|mjs)$/;
const JSON_FILE = /\.json$/;

interface Node {
  declaration?: { end: number; start: number } | null;
  end: number;
  source?: unknown;
  start: number;
  type: string;
}

/** The entry's module-level imports stay where they are. Everything else moves into one async function. */
const wrapEntry = (code: string): string => {
  const program = parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as { body: Node[] };
  const imports: string[] = [];
  const body: string[] = [];
  for (const node of program.body) {
    const text = code.slice(node.start, node.end);
    if (node.type === "ImportDeclaration") {
      imports.push(text);
    } else if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration &&
      !node.source
    ) {
      // `export const x = 1` in a script is just `const x = 1`.
      body.push(code.slice(node.declaration.start, node.declaration.end));
    } else if (node.type.startsWith("Export")) {
      throw new Error(
        "The entry script cannot use `export default`, export lists or re-exports."
      );
    } else {
      body.push(text);
    }
  }
  return `${imports.join("\n")}\nexport default async function ${ENTRY_FUNCTION}() {\n${body.join("\n")}\n}\n`;
};

const toJavaScript = (path: string, source: string): string =>
  TYPESCRIPT.test(path)
    ? transform(source, { filePath: path, transforms: ["typescript"] }).code
    : source;

const toModule = (file: SandboxFile, entry: string): BundleModule => {
  if (file.path === entry) {
    return {
      js: wrapEntry(toJavaScript(file.path, decoder.decode(file.bytes))),
    };
  }
  if (TYPESCRIPT.test(file.path) || JAVASCRIPT.test(file.path)) {
    return { js: toJavaScript(file.path, decoder.decode(file.bytes)) };
  }
  if (JSON_FILE.test(file.path)) {
    return { json: JSON.parse(decoder.decode(file.bytes)) };
  }
  return {
    data: file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength
    ) as ArrayBuffer,
  };
};

/**
 * One module per file, keyed by its skill-relative path, so `./lib.ts` in
 * `scripts/hello.ts` resolves to `scripts/lib.ts`. A file that does not
 * parse fails the whole build, and the message names it.
 */
export const buildModules = (
  files: readonly SandboxFile[],
  entry: string
): Record<string, BundleModule> => {
  const modules: Record<string, BundleModule> = {};
  for (const file of files) {
    try {
      modules[file.path] = toModule(file, entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${file.path}: ${reason}`, { cause: error });
    }
  }
  return modules;
};
