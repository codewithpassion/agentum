import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { serve } from "bun";
import { createFetchRemote } from "./transfer-remote.ts";

const TOKEN = "hm_test_token_123";
const TEXT = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

interface StoredFile {
  bytes: Uint8Array;
  etag: string;
}

interface Stub {
  authorizations: string[];
  conflicts: unknown[];
  files: Map<string, StoredFile>;
  stop: () => void;
  url: string;
  writes: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const entryOf = (path: string, file: StoredFile) => ({
  etag: file.etag,
  kind: "file" as const,
  path,
  size: file.bytes.byteLength,
});

const startStub = (): Stub => {
  const stub: Stub = {
    authorizations: [],
    conflicts: [],
    files: new Map(),
    stop: () => undefined,
    url: "",
    writes: 0,
  };
  const server = serve({
    fetch: async (req) => {
      const url = new URL(req.url);
      stub.authorizations.push(req.headers.get("authorization") ?? "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const path = url.searchParams.get("path") ?? "";
      const route = url.pathname.replace("/lib", "");

      if (route === "/list" && req.method === "GET") {
        const entries = [...stub.files]
          .filter(([name]) => name.startsWith(`${path}/`))
          .filter(([name]) => !name.slice(path.length + 1).includes("/"))
          .map(([name, file]) => entryOf(name, file));
        return entries.length === 0
          ? json({ error: "not found" }, 404)
          : json({ entries });
      }

      if (route === "/stat" && req.method === "GET") {
        const file = stub.files.get(path);
        return file === undefined
          ? json({ error: "not found" }, 404)
          : json({ entry: entryOf(path, file) });
      }

      if (route === "/file" && req.method === "GET") {
        if (path === "boom") {
          return json({ error: "disk full" }, 500);
        }
        if (path === "echo") {
          return json({ error: `token ${TOKEN} was rejected` }, 500);
        }
        if (path === "folder") {
          return json({ error: "is a folder" }, 400);
        }
        const file = stub.files.get(path);
        if (file === undefined) {
          return json({ error: "not found" }, 404);
        }
        return new Response(file.bytes, {
          headers: { "X-Library-Etag": file.etag },
        });
      }

      if (route === "/file" && req.method === "PUT") {
        const current = stub.files.get(path);
        const ifEtag = req.headers.get("X-Library-If-Etag");
        if (ifEtag !== null && current?.etag !== ifEtag) {
          return json({ error: "etag changed" }, 409);
        }
        stub.writes += 1;
        const etag = `w${stub.writes}`;
        const bytes = new Uint8Array(await req.arrayBuffer());
        stub.files.set(path, { bytes, etag });
        return json({ etag });
      }

      if (route === "/file" && req.method === "DELETE") {
        if (!stub.files.delete(path)) {
          return json({ error: "not found" }, 404);
        }
        return new Response(null, { status: 204 });
      }

      if (route === "/conflicts" && req.method === "POST") {
        const body: unknown = await req.json();
        stub.conflicts.push(body);
        return json({}, 201);
      }

      if (route === "/run" && req.method === "GET") {
        return json({ runId: "run-7" });
      }

      return json({ error: "no such route" }, 404);
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  stub.url = `http://127.0.0.1:${server.port}/lib`;
  stub.stop = () => server.stop(true);
  return stub;
};

const seed = (stub: Stub): void => {
  stub.authorizations.length = 0;
  stub.conflicts.length = 0;
  stub.files.clear();
  stub.writes = 0;
  stub.files.set("notes/a.md", {
    bytes: TEXT.encode("alpha"),
    etag: "e1",
  });
  stub.files.set("notes/b.md", {
    bytes: TEXT.encode("beta"),
    etag: "e2",
  });
};

describe("createFetchRemote", () => {
  let stub: Stub;

  beforeAll(() => {
    stub = startStub();
  });

  afterAll(() => {
    stub.stop();
  });

  beforeEach(() => {
    seed(stub);
  });

  const remote = () => createFetchRemote({ base: stub.url, token: TOKEN });

  test("list returns the entries of a folder and sends the token", async () => {
    const entries = await remote().list("notes");
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(entries[0]).toEqual({
      etag: "e1",
      kind: "file",
      path: "notes/a.md",
      size: 5,
    });
    expect(
      stub.authorizations.every((auth) => auth === `Bearer ${TOKEN}`)
    ).toBe(true);
  });

  test("list of a folder that is not there is empty", async () => {
    expect(await remote().list("missing")).toEqual([]);
  });

  test("stat returns the entry, or null when there is none", async () => {
    expect(await remote().stat("notes/a.md")).toEqual({
      etag: "e1",
      kind: "file",
      path: "notes/a.md",
      size: 5,
    });
    expect(await remote().stat("notes/none.md")).toBeNull();
  });

  test("read returns the bytes with the etag", async () => {
    const found = await remote().read("notes/b.md");
    expect(found).not.toBeNull();
    expect(found?.etag).toBe("e2");
    expect(TEXT_DECODER.decode(found?.bytes)).toBe("beta");
  });

  test("read of a missing file or a folder is null", async () => {
    expect(await remote().read("notes/none.md")).toBeNull();
    expect(await remote().read("folder")).toBeNull();
  });

  test("write stores plain bytes and returns the new etag", async () => {
    const written = await remote().write("notes/c.md", TEXT.encode("gamma"));
    expect(written).toEqual({ etag: "w1" });
    expect(TEXT_DECODER.decode(stub.files.get("notes/c.md")?.bytes)).toBe(
      "gamma"
    );
  });

  test("write with the current etag stores the bytes", async () => {
    const written = await remote().write("notes/a.md", TEXT.encode("alpha 2"), {
      ifEtag: "e1",
    });
    expect(written).toEqual({ etag: "w1" });
    expect(TEXT_DECODER.decode(stub.files.get("notes/a.md")?.bytes)).toBe(
      "alpha 2"
    );
  });

  test("write with a stale etag answers null and keeps the file", async () => {
    const written = await remote().write("notes/a.md", TEXT.encode("stale"), {
      ifEtag: "e0",
    });
    expect(written).toBeNull();
    expect(TEXT_DECODER.decode(stub.files.get("notes/a.md")?.bytes)).toBe(
      "alpha"
    );
  });

  test("delete removes a file, and a file that is not there is fine", async () => {
    await remote().delete("notes/a.md");
    expect(stub.files.has("notes/a.md")).toBe(false);
    await expect(remote().delete("notes/a.md")).resolves.toBeUndefined();
  });

  test("recordConflict posts the conflict body", async () => {
    await remote().recordConflict({
      conflictPath: "notes/a.md.conflict-run-7",
      path: "notes/a.md",
    });
    expect(stub.conflicts).toEqual([
      { conflictPath: "notes/a.md.conflict-run-7", path: "notes/a.md" },
    ]);
  });

  test("runId returns the id of the run", async () => {
    expect(await remote().runId()).toBe("run-7");
  });

  test("a 500 answer throws with the server error text", async () => {
    const error = await remote()
      .read("boom")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "library file answered HTTP 500: disk full"
    );
  });

  test("a server that echoes the token does not leak it into the message", async () => {
    const error = await remote()
      .read("echo")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).not.toContain(TOKEN);
    expect(message).toBe(
      "library file answered HTTP 500: token [token] was rejected"
    );
  });

  test("a refused connection throws with the cause", async () => {
    const closed = startStub();
    const { port } = new URL(closed.url);
    closed.stop();
    const refused = createFetchRemote({
      base: `http://127.0.0.1:${port}/lib`,
      token: TOKEN,
    });
    const error = await refused
      .list("notes")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const { cause, message } = error as Error;
    expect(message).toBe("library list request failed");
    expect(cause).toBeDefined();
  });

  test("trailing slashes on the base are dropped", async () => {
    const slashed = createFetchRemote({
      base: `${stub.url}///`,
      token: TOKEN,
    });
    expect(await slashed.runId()).toBe("run-7");
  });
});
