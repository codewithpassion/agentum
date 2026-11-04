/**
 * The module map of an app's server part, for one Dynamic Worker. The app's
 * `server/` files go in as they are, and a harness module hands each request
 * the `AgentumHost` binding and the app's `fetch`. Nothing is wrapped or rewritten.
 * `checkServerBundle` runs at publish, so a bad bundle is refused before a
 * viewer loads it.
 */
import {
  type ExportSpecifier,
  type ObjectExpression,
  type Program,
  parse,
} from "acorn";
import type { SandboxFile } from "../skill-scripts/sandbox-port.ts";

export const APP_SERVER_ENTRY = "server/index.js";
export const APP_HARNESS = "__harness.js";

/** The module the Worker runs. It names the app's default export and the `AgentumHost` binding, and nothing else. */
export const HARNESS_SOURCE = [
  'import { WorkerEntrypoint } from "cloudflare:workers";',
  'import app from "./server/index.js";',
  "export class Harness extends WorkerEntrypoint {",
  "  async handle(request, agentum) {",
  "    return app.fetch(request, { ...this.env, AGENTUM: agentum }, this.ctx);",
  "  }",
  "}",
  'export default { fetch: () => new Response("use Harness", { status: 404 }) };',
  "",
].join("\n");

/** One module as a Dynamic Worker loader takes it. */
export type AppModule =
  | { data: ArrayBuffer }
  | { js: string }
  | { json: unknown };

const SERVER_DIR = "server/";
const TYPESCRIPT_OR_JSX = /\.(?:ts|mts|tsx|jsx)$/;
const JAVASCRIPT = /\.(?:js|mjs)$/;
const JSON_FILE = /\.json$/;

const decoder = new TextDecoder();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseModule = (text: string): Program =>
  parse(text, { ecmaVersion: "latest", sourceType: "module" });

const moduleOf = (file: SandboxFile): AppModule => {
  if (!file.path.startsWith(SERVER_DIR)) {
    throw new Error(`${file.path}: not under server/`);
  }
  if (TYPESCRIPT_OR_JSX.test(file.path)) {
    throw new Error(
      `${file.path}: TypeScript and JSX are not supported in server/, pre-bundle to JavaScript`
    );
  }
  if (JAVASCRIPT.test(file.path)) {
    return { js: decoder.decode(file.bytes) };
  }
  if (JSON_FILE.test(file.path)) {
    try {
      return { json: JSON.parse(decoder.decode(file.bytes)) };
    } catch (error) {
      throw new Error(`${file.path}: invalid JSON (${messageOf(error)})`, {
        cause: error,
      });
    }
  }
  return { data: file.bytes.slice().buffer };
};

/** One module per file under `server/`, keyed by its path, plus the harness. Throws naming the file when one cannot load. */
export const appModules = (
  files: readonly SandboxFile[]
): Record<string, AppModule> => {
  const modules: Record<string, AppModule> = {
    [APP_HARNESS]: { js: HARNESS_SOURCE },
  };
  for (const file of files) {
    modules[file.path] = moduleOf(file);
  }
  return modules;
};

/** True when a property of an object literal could be `fetch`. A spread or a computed key might be, so it counts. */
const mayDefineFetch = (
  property: ObjectExpression["properties"][number]
): boolean => {
  if (property.type !== "Property") {
    return true;
  }
  const { key } = property;
  if (key.type === "Literal") {
    return key.value === "fetch";
  }
  if (key.type === "Identifier") {
    return property.computed || key.name === "fetch";
  }
  return true;
};

const exportedName = (specifier: ExportSpecifier): string =>
  specifier.exported.type === "Identifier"
    ? specifier.exported.name
    : String(specifier.exported.value);

const NO_DEFAULT = "no default export, add `export default { fetch }`";
const NO_FETCH =
  "default export is an object without fetch, add a fetch method";

/** Checks only what the source shows: a missing default export, or an object literal that has no `fetch`. */
const defaultExportProblem = (program: Program): string | undefined => {
  for (const node of program.body) {
    if (node.type === "ExportDefaultDeclaration") {
      const { declaration } = node;
      const withoutFetch =
        declaration.type === "ObjectExpression" &&
        !declaration.properties.some(mayDefineFetch);
      return withoutFetch ? NO_FETCH : undefined;
    }
    if (
      node.type === "ExportNamedDeclaration" &&
      node.specifiers.some((specifier) => exportedName(specifier) === "default")
    ) {
      return;
    }
  }
  return NO_DEFAULT;
};

/** Problems with one file on its own: a path or type the loader refuses, or JavaScript acorn cannot parse. */
const fileProblems = (file: SandboxFile): string[] => {
  try {
    moduleOf(file);
  } catch (error) {
    return [messageOf(error)];
  }
  if (!JAVASCRIPT.test(file.path)) {
    return [];
  }
  try {
    parseModule(decoder.decode(file.bytes));
    return [];
  } catch (error) {
    return [`${file.path}: ${messageOf(error)}`];
  }
};

/** The entry's default export. A parse error is left to `fileProblems`, which already names it. */
const entryProblems = (files: readonly SandboxFile[]): string[] => {
  const entry = files.find((file) => file.path === APP_SERVER_ENTRY);
  if (entry === undefined) {
    return [`${APP_SERVER_ENTRY}: missing, an app needs a server entry`];
  }
  let program: Program;
  try {
    program = parseModule(decoder.decode(entry.bytes));
  } catch {
    return [];
  }
  const problem = defaultExportProblem(program);
  return problem === undefined ? [] : [`${APP_SERVER_ENTRY}: ${problem}`];
};

/** Publish-time checks on a version's `server/` files. An empty list means the bundle may be stored. */
export const checkServerBundle = (files: readonly SandboxFile[]): string[] => [
  ...entryProblems(files),
  ...files.flatMap(fileProblems),
];
