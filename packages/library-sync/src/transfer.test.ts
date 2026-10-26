import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "bun";
import { runTransfer } from "./transfer.ts";
import { SYNC_MAX_FILE_BYTES } from "./types.ts";

const TOKEN = "test-token";
const ROUTE = "/api/session/library";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface StubFile {
  bytes: Uint8Array;
  etag: string;
}

interface Stub {
  conflicts: unknown[];
  failing: Set<string>;
  files: Map<string, StubFile>;
  origin: string;
  seq: number;
  stop: () => void;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const fileEntry = (path: string, file: StubFile) => ({
  etag: file.etag,
  kind: "file" as const,
  path,
  size: file.bytes.byteLength,
});

const isFolder = (state: Stub, path: string): boolean =>
  [...state.files.keys()].some((name) => name.startsWith(`${path}/`));

const entryAt = (state: Stub, path: string) => {
  const file = state.files.get(path);
  if (file !== undefined) {
    return fileEntry(path, file);
  }
  return isFolder(state, path)
    ? { etag: null, kind: "dir" as const, path, size: 0 }
    : null;
};

const listOf = (state: Stub, folderPath: string) => {
  const prefix = `${folderPath}/`;
  const found = new Map<string, object>();
  for (const [path, file] of state.files) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      found.set(path, fileEntry(path, file));
    } else {
      const folder = `${folderPath}/${rest.slice(0, slash)}`;
      found.set(folder, { etag: null, kind: "dir", path: folder, size: 0 });
    }
  }
  return [...found.values()];
};

const fileRoute = async (
  state: Stub,
  req: Request,
  path: string
): Promise<Response> => {
  const current = state.files.get(path);
  if (req.method === "GET") {
    if (state.failing.has(path)) {
      return json({ error: "disk full" }, 500);
    }
    if (current === undefined) {
      return isFolder(state, path)
        ? json({ error: "is a folder" }, 400)
        : json({ error: "not found" }, 404);
    }
    return new Response(current.bytes, {
      headers: { "X-Library-Etag": current.etag },
    });
  }
  if (req.method === "PUT") {
    const ifEtag = req.headers.get("X-Library-If-Etag");
    if (ifEtag !== null && current?.etag !== ifEtag) {
      return json({ error: "etag changed" }, 409);
    }
    state.seq += 1;
    const etag = `e${state.seq}`;
    state.files.set(path, {
      bytes: new Uint8Array(await req.arrayBuffer()),
      etag,
    });
    return json({ etag });
  }
  if (req.method === "DELETE") {
    if (!state.files.delete(path)) {
      return json({ error: "not found" }, 404);
    }
    return new Response(null, { status: 204 });
  }
  return json({ error: "method not allowed" }, 405);
};

const handle = async (state: Stub, req: Request): Promise<Response> => {
  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(req.url);
  if (!url.pathname.startsWith(ROUTE)) {
    return json({ error: "no such route" }, 404);
  }
  const route = url.pathname.slice(ROUTE.length);
  const path = url.searchParams.get("path") ?? "";
  if (route === "/list" && req.method === "GET") {
    return json({ entries: listOf(state, path) });
  }
  if (route === "/stat" && req.method === "GET") {
    const entry = entryAt(state, path);
    return entry === null ? json({ error: "not found" }, 404) : json({ entry });
  }
  if (route === "/file") {
    return fileRoute(state, req, path);
  }
  if (route === "/conflicts" && req.method === "POST") {
    const body: unknown = await req.json();
    state.conflicts.push(body);
    return json({}, 201);
  }
  if (route === "/run" && req.method === "GET") {
    return json({ runId: "run_1" });
  }
  return json({ error: "no such route" }, 404);
};

const startStub = (): Stub => {
  const stub: Stub = {
    conflicts: [],
    failing: new Set(),
    files: new Map(),
    origin: "",
    seq: 0,
    stop: () => undefined,
  };
  const server = serve({
    fetch: (req) => handle(stub, req),
    hostname: "127.0.0.1",
    port: 0,
  });
  stub.origin = `http://127.0.0.1:${server.port}`;
  stub.stop = () => {
    server.stop(true);
  };
  return stub;
};

let stub: Stub;
let root = "";
let dir = "";
let logs: string[] = [];

beforeEach(async () => {
  stub = startStub();
  root = await mkdtemp(join(tmpdir(), "library-transfer-"));
  dir = join(root, "library");
  logs = [];
});

afterEach(async () => {
  stub.stop();
  await rm(root, { force: true, recursive: true });
});

/** Runs the script with the stub's origin and the test token, and checks that the token never reaches a log line. */
const run = async (
  argv: readonly string[],
  env: Record<string, string | undefined> = {}
): Promise<{ code: number; output: string }> => {
  const code = await runTransfer({
    argv,
    env: { HM_LIBRARY_TOKEN: TOKEN, HM_LIBRARY_URL: stub.origin, ...env },
    log: (line) => {
      logs.push(line);
    },
  });
  const output = logs.join("\n");
  if (output.includes(TOKEN)) {
    throw new Error("the token reached a log line");
  }
  return { code, output };
};

const pull = (...paths: string[]) => run(["pull", "--dir", dir, ...paths]);

const push = (...paths: string[]) => run(["push", "--dir", dir, ...paths]);

const putStub = (path: string, text: string): void => {
  stub.seq += 1;
  stub.files.set(path, { bytes: ENCODER.encode(text), etag: `s${stub.seq}` });
};

const stubText = (path: string): string | undefined => {
  const file = stub.files.get(path);
  return file === undefined ? undefined : DECODER.decode(file.bytes);
};

const localPath = (path: string): string => join(dir, path);

const writeLocal = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(localPath(path)), { recursive: true });
  await writeFile(localPath(path), text);
};

const readLocal = (path: string): Promise<string> =>
  readFile(localPath(path), "utf8");

const exists = (path: string): Promise<boolean> =>
  access(localPath(path)).then(
    () => true,
    () => false
  );

describe("pull", () => {
  test("copies a folder with nested files under the dir", async () => {
    putStub("agents/ada/notes.md", "notes");
    putStub("agents/ada/skills/search/SKILL.md", "skill");
    putStub("agents/ada/config.json", "{}");

    const { code } = await pull("agents/ada");

    expect(code).toBe(0);
    expect(logs).toEqual([
      "pulled 3, removed 0, kept 0 for local edits, skipped 0 over 10 MB, failed 0",
    ]);
    expect(await readLocal("agents/ada/notes.md")).toBe("notes");
    expect(await readLocal("agents/ada/skills/search/SKILL.md")).toBe("skill");
    expect(await readLocal("agents/ada/config.json")).toBe("{}");
  });

  test("keeps a local edit when the library did not change", async () => {
    putStub("agents/ada/notes.md", "v1");
    await pull("agents/ada");
    await writeLocal("agents/ada/notes.md", "my edit");

    const { code } = await pull("agents/ada");

    expect(code).toBe(0);
    expect(await readLocal("agents/ada/notes.md")).toBe("my edit");
  });

  test("keeps a local edit when the library changed and says so", async () => {
    putStub("agents/ada/notes.md", "v1");
    await pull("agents/ada");
    await writeLocal("agents/ada/notes.md", "my edit");
    putStub("agents/ada/notes.md", "v2");

    const { code, output } = await pull("agents/ada");

    expect(code).toBe(0);
    expect(output).toContain("kept 1 for local edits");
    expect(output).toContain("kept agents/ada/notes.md (local edits not sent)");
    expect(await readLocal("agents/ada/notes.md")).toBe("my edit");
  });

  test("fails one file, pulls the rest and exits 1", async () => {
    putStub("agents/ada/ok.md", "fine");
    putStub("agents/ada/broken.md", "boom");
    stub.failing.add("agents/ada/broken.md");

    const { code, output } = await pull("agents/ada");

    expect(code).toBe(1);
    expect(output).toContain("failed 1");
    expect(output).toContain(
      "failed agents/ada/broken.md: library file answered HTTP 500: disk full"
    );
    expect(await readLocal("agents/ada/ok.md")).toBe("fine");
  });

  test("skips a file over 10 MB", async () => {
    stub.files.set("agents/ada/big.bin", {
      bytes: new Uint8Array(SYNC_MAX_FILE_BYTES + 1),
      etag: "big",
    });

    const { code } = await pull("agents/ada");

    expect(code).toBe(0);
    expect(logs).toEqual([
      "pulled 0, removed 0, kept 0 for local edits, skipped 1 over 10 MB, failed 0",
    ]);
    expect(await exists("agents/ada/big.bin")).toBe(false);
  });

  test("takes the URL from a flag with trailing slashes and the dir from HM_LIBRARY_DIR", async () => {
    putStub("agents/ada/notes.md", "notes");

    const { code } = await run(
      ["pull", `--url=${stub.origin}///`, "agents/ada"],
      { HM_LIBRARY_DIR: dir, HM_LIBRARY_URL: undefined }
    );

    expect(code).toBe(0);
    expect(await readLocal("agents/ada/notes.md")).toBe("notes");
  });
});

describe("push", () => {
  test("sends a new file, a changed file and a deleted file", async () => {
    putStub("agents/ada/notes.md", "old");
    putStub("agents/ada/old.md", "gone");
    await pull("agents/ada");
    await writeLocal("agents/ada/notes.md", "new");
    await writeLocal("agents/ada/fresh.md", "fresh");
    await rm(localPath("agents/ada/old.md"));
    logs = [];

    const { code, output } = await push("agents/ada");

    expect(code).toBe(0);
    expect(output.split("\n")[0]).toBe(
      "written 2, deleted 1, conflicts 0, skipped 0 over 10 MB, refused 0, failed 0"
    );
    expect(output).toContain("wrote agents/ada/notes.md");
    expect(output).toContain("wrote agents/ada/fresh.md");
    expect(output).toContain("deleted agents/ada/old.md");
    expect(stubText("agents/ada/notes.md")).toBe("new");
    expect(stubText("agents/ada/fresh.md")).toBe("fresh");
    expect(stubText("agents/ada/old.md")).toBeUndefined();
  });

  test("pushes the whole dir when no path is given", async () => {
    await writeLocal("agents/grace/notes.md", "grace");
    await writeLocal("README.md", "readme");

    const { code, output } = await push();

    expect(code).toBe(0);
    expect(output).toContain("written 2,");
    expect(stubText("agents/grace/notes.md")).toBe("grace");
    expect(stubText("README.md")).toBe("readme");
  });

  test("with no path, a top-level folder deleted here is deleted in the library", async () => {
    putStub("agents/ada/notes.md", "ada");
    await pull("agents/ada");
    await rm(localPath("agents"), { force: true, recursive: true });
    logs = [];

    const { code, output } = await push();

    expect(code).toBe(0);
    expect(output).toContain("deleted agents/ada/notes.md");
    expect(stubText("agents/ada/notes.md")).toBeUndefined();
  });

  test("pushes nothing and exits 0 when the dir is missing", async () => {
    const { code, output } = await push();

    expect(code).toBe(0);
    expect(output).toContain("nothing to push");
    expect(stub.files.size).toBe(0);
  });

  test("saves a conflict copy, records it and exits 0", async () => {
    putStub("agents/ada/notes.md", "v1");
    await pull("agents/ada");
    putStub("agents/ada/notes.md", "library edit");
    await writeLocal("agents/ada/notes.md", "my edit");

    const { code, output } = await push("agents/ada");

    expect(code).toBe(0);
    expect(output).toContain("conflicts 1,");
    expect(output).toContain(
      "conflict: agents/ada/notes.md changed in the library meanwhile, your copy is saved as agents/ada/notes.md.conflict-run_1"
    );
    expect(stubText("agents/ada/notes.md")).toBe("library edit");
    expect(stubText("agents/ada/notes.md.conflict-run_1")).toBe("my edit");
    expect(stub.conflicts).toEqual([
      {
        conflictPath: "agents/ada/notes.md.conflict-run_1",
        path: "agents/ada/notes.md",
      },
    ]);
    expect(await readLocal("agents/ada/notes.md")).toBe("library edit");
  });

  test("a later pull lists the waiting conflict copy", async () => {
    putStub("agents/ada/notes.md", "v1");
    await pull("agents/ada");
    putStub("agents/ada/notes.md", "library edit");
    await writeLocal("agents/ada/notes.md", "my edit");
    await push("agents/ada");

    const { code, output } = await pull("agents/ada");

    expect(code).toBe(0);
    expect(output).toContain(
      "conflict copy waiting: agents/ada/notes.md.conflict-run_1"
    );
  });
});

describe("errors", () => {
  test("a wrong token exits 1 and the token is not printed", async () => {
    putStub("agents/ada/notes.md", "notes");

    const { code, output } = await run(["pull", "--dir", dir, "agents/ada"], {
      HM_LIBRARY_TOKEN: "wrong-token",
    });

    expect(code).toBe(1);
    expect(output).toContain("error: library stat answered HTTP 401");
    expect(output).not.toContain("wrong-token");
  });

  test.each([
    ["no arguments", [], {}],
    ["an unknown command", ["sync", "--dir", "/x"], {}],
    ["an unknown option", ["pull", "--verbose", "agents/ada"], {}],
    ["a flag without a value", ["pull", "--dir"], {}],
    [
      "a missing token",
      ["pull", "--dir", "/x", "agents/ada"],
      { HM_LIBRARY_TOKEN: undefined },
    ],
    [
      "a missing URL",
      ["pull", "--dir", "/x", "agents/ada"],
      { HM_LIBRARY_URL: undefined },
    ],
    ["an invalid URL", ["pull", "--url", "not a url", "agents/ada"], {}],
    ["pull without a path", ["pull", "--dir", dir], {}],
    [
      "a path with a .. segment",
      ["pull", "--dir", dir, "agents/../secrets"],
      {},
    ],
  ])("%s exits 2 with one error line", async (_name, argv, env) => {
    const { code } = await run(argv, env);

    expect(code).toBe(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.startsWith("error:")).toBe(true);
  });
});
