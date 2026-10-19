import { describe, expect, test } from "bun:test";
import type { LibraryEntry } from "@repo/services/library";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import type { WebFetcher, WebFetchRequest } from "../web-fetch/types.ts";
import { NETWORK_OFF_MESSAGE } from "../web-fetch/types.ts";
import { createScriptHost } from "./script-host-core.ts";

const HOME = "agents/robo";
const BYTES = new TextEncoder().encode("hello");

const entry = (path: string, kind: "dir" | "file" = "file"): LibraryEntry => ({
  etag: null,
  kind,
  mtime: "2026-10-19T00:00:00.000Z",
  path,
  size: 0,
  updatedBy: { id: "agent-1", kind: "agent" },
});

/** An in-memory `ops` that records each path it is asked for. */
const fakeOps = (files: Record<string, Uint8Array> = {}) => {
  const calls: { op: string; path: string }[] = [];
  const written: Record<string, Uint8Array> = {};
  const ops: Pick<LibraryOps, "list" | "read" | "write"> = {
    list: (dir) => {
      calls.push({ op: "list", path: dir });
      return Promise.resolve([
        entry(`${dir}/notes`, "dir"),
        entry(`${dir}/a.ts`),
      ]);
    },
    read: (path) => {
      calls.push({ op: "read", path });
      const bytes = files[path];
      if (bytes === undefined) {
        return Promise.reject(new Error(`missing ${path}`));
      }
      return Promise.resolve({ bytes, entry: entry(path) });
    },
    write: (path, bytes) => {
      calls.push({ op: "write", path });
      written[path] = bytes;
      return Promise.resolve(entry(path));
    },
  };
  return { calls, ops, written };
};

const okFetcher =
  (requests: WebFetchRequest[]): WebFetcher =>
  (request) => {
    requests.push(request);
    return Promise.resolve({
      bytes: BYTES,
      durationMs: 1,
      headers: { "content-type": "text/plain" },
      ok: true,
      status: 200,
      statusText: "OK",
      url: request.url,
    });
  };

describe("createScriptHost paths", () => {
  test("reads a relative path from the home folder", async () => {
    const { calls, ops } = fakeOps({ "agents/robo/a.txt": BYTES });
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    expect(await host.read("a.txt")).toEqual(BYTES);
    expect(calls).toEqual([{ op: "read", path: "agents/robo/a.txt" }]);
  });

  test("reads an absolute library path as given", async () => {
    const { calls, ops } = fakeOps({ "shared/a.txt": BYTES });
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    expect(await host.read("/library/shared/a.txt")).toEqual(BYTES);
    expect(calls).toEqual([{ op: "read", path: "shared/a.txt" }]);
  });

  test("rejects a path outside /library before it reaches the ops", async () => {
    const { calls, ops } = fakeOps();
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    await expect(host.read("/etc/passwd")).rejects.toThrow(
      "Path is outside /library: /etc/passwd"
    );
    expect(calls).toEqual([]);
  });

  test("writes bytes to the resolved library path", async () => {
    const { calls, ops, written } = fakeOps();
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    expect(await host.write("out/b.bin", BYTES)).toBeUndefined();
    expect(calls).toEqual([{ op: "write", path: "agents/robo/out/b.bin" }]);
    expect(written["agents/robo/out/b.bin"]).toEqual(BYTES);
  });
});

describe("createScriptHost list", () => {
  test("names each entry by its last path segment", async () => {
    const { calls, ops } = fakeOps();
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    expect(await host.list("/library/agents/robo")).toEqual([
      { kind: "dir", name: "notes" },
      { kind: "file", name: "a.ts" },
    ]);
    expect(calls).toEqual([{ op: "list", path: "agents/robo" }]);
  });
});

describe("createScriptHost send", () => {
  test("answers network off without calling anything", async () => {
    const { calls, ops } = fakeOps();
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    const result = await host.send({
      headers: [],
      method: "GET",
      url: "https://example.com",
    });
    expect(result).toEqual({ message: NETWORK_OFF_MESSAGE, ok: false });
    expect(calls).toEqual([]);
  });

  test("passes the request to the fetcher and maps a success", async () => {
    const requests: WebFetchRequest[] = [];
    const { ops } = fakeOps();
    const host = createScriptHost({
      fetcher: okFetcher(requests),
      home: HOME,
      ops,
    });
    const result = await host.send({
      body: BYTES,
      headers: [["x-test", "1"]],
      method: "POST",
      url: "https://example.com/api",
    });
    expect(requests).toEqual([
      {
        body: BYTES,
        headers: { "x-test": "1" },
        method: "POST",
        url: "https://example.com/api",
      },
    ]);
    expect(result).toEqual({
      body: BYTES,
      headers: [["content-type", "text/plain"]],
      ok: true,
      status: 200,
      statusText: "OK",
    });
  });

  test("leaves the body out when the request has none", async () => {
    const requests: WebFetchRequest[] = [];
    const { ops } = fakeOps();
    const host = createScriptHost({
      fetcher: okFetcher(requests),
      home: HOME,
      ops,
    });
    await host.send({ headers: [], method: "GET", url: "https://example.com" });
    expect(requests).toHaveLength(1);
    expect("body" in (requests[0] ?? {})).toBe(false);
  });

  test("maps a failed fetch to its message", async () => {
    const fetcher: WebFetcher = async () => ({
      error: "blocked",
      message: "That host is blocked.",
      ok: false,
    });
    const { ops } = fakeOps();
    const host = createScriptHost({ fetcher, home: HOME, ops });
    expect(
      await host.send({ headers: [], method: "GET", url: "http://x" })
    ).toEqual({ message: "That host is blocked.", ok: false });
  });

  test("turns a rejecting fetcher into a failed result", async () => {
    const fetcher: WebFetcher = () => Promise.reject(new Error("socket reset"));
    const { ops } = fakeOps();
    const host = createScriptHost({ fetcher, home: HOME, ops });
    expect(
      await host.send({ headers: [], method: "GET", url: "https://x" })
    ).toEqual({ message: "The request failed.", ok: false });
  });

  test("refuses arguments of the wrong type before they reach the library", async () => {
    const { calls, ops } = fakeOps();
    const host = createScriptHost({ fetcher: undefined, home: HOME, ops });
    const loose = host as unknown as Record<
      "list" | "read" | "write",
      (...args: unknown[]) => Promise<unknown>
    >;
    await expect(loose.write("a.txt", "not bytes")).rejects.toThrow(
      "Uint8Array"
    );
    await expect(loose.write(42, BYTES)).rejects.toThrow("string");
    await expect(loose.read({})).rejects.toThrow("string");
    await expect(loose.list(null)).rejects.toThrow("string");
    expect(calls).toEqual([]);
  });
});
