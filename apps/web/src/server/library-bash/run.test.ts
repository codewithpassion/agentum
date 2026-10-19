import { beforeEach, describe, expect, test } from "bun:test";
import type {
  WebFetcher,
  WebFetchRequest,
  WebFetchResult,
} from "../web-fetch/types.ts";
import type { LibraryOps } from "./library-fs.ts";
import { runLibraryBash } from "./run.ts";

const PLACEHOLDER = "hm-secret:SUPADATA_KEY";

// These scripts never touch /library, so the library operations are never called.
const refuse = () => Promise.reject(new Error("the library is not used here"));
const ops: LibraryOps = {
  list: refuse,
  mkdir: refuse,
  move: refuse,
  read: refuse,
  remove: refuse,
  stat: refuse,
  write: refuse,
};

let calls: WebFetchRequest[];

const fetcher: WebFetcher = (request) => {
  calls.push(request);
  const next: WebFetchResult = {
    bytes: new TextEncoder().encode("ok\n"),
    durationMs: 1,
    headers: {},
    ok: true,
    status: 200,
    statusText: "OK",
    url: request.url,
  };
  return Promise.resolve(next);
};

const run = (script: string, env?: Record<string, string>) =>
  runLibraryBash({ env, ops, script, web: fetcher });

beforeEach(() => {
  calls = [];
});

describe("runLibraryBash env", () => {
  test("a variable from env expands to its value", async () => {
    const result = await run("echo $SUPADATA_KEY", {
      SUPADATA_KEY: PLACEHOLDER,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${PLACEHOLDER}\n`);
  });

  test("braces and adjacent text expand too", async () => {
    const result = await run(`echo "\${SUPADATA_KEY}x"`, {
      SUPADATA_KEY: PLACEHOLDER,
    });
    expect(result.stdout).toBe(`${PLACEHOLDER}x\n`);
  });

  test("env lists the variable", async () => {
    const result = await run("env | grep SUPADATA", {
      SUPADATA_KEY: PLACEHOLDER,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`SUPADATA_KEY=${PLACEHOLDER}\n`);
  });

  test("without env the variable is empty", async () => {
    const result = await run('echo "[$SUPADATA_KEY]"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
  });

  test("curl sends the placeholder in a header", async () => {
    const result = await run(
      'curl -s -H "x-api-key: $SUPADATA_KEY" https://example.com/a',
      { SUPADATA_KEY: PLACEHOLDER }
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ "x-api-key": PLACEHOLDER });
  });

  test("variables do not persist into a later call", async () => {
    await run("echo $SUPADATA_KEY", { SUPADATA_KEY: PLACEHOLDER });
    const result = await run('echo "[$SUPADATA_KEY]"');
    expect(result.stdout).toBe("[]\n");
  });
});
