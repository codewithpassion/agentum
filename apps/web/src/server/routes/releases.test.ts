import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ORIGIN_PLACEHOLDER } from "../releases/install-script.ts";
import type { ReleaseBucket, ReleaseObject } from "../releases/store.ts";
import type { AppEnv } from "./groups.ts";
import { mountReleaseRoutes } from "./releases.ts";

const ORIGIN = "https://hm.test";
const BINARY = "binary-bytes";
const DAEMON_SCRIPT = `HM_ORIGIN="${ORIGIN_PLACEHOLDER}"\n# daemon`;
const COMPUTER_SCRIPT = `HM_ORIGIN="${ORIGIN_PLACEHOLDER}"\n# computer`;

const object = (text: string): ReleaseObject => ({
  body: new Response(text).body as ReadableStream,
  httpEtag: `"etag-${text.length}"`,
  size: new TextEncoder().encode(text).length,
  text: () => Promise.resolve(text),
});

const setup = (seed: Record<string, string> = {}) => {
  const asked: string[] = [];
  const bucket: ReleaseBucket = {
    get: (key) => {
      asked.push(key);
      const text = seed[key];
      return Promise.resolve(text === undefined ? null : object(text));
    },
  };
  const app = new Hono<AppEnv>();
  mountReleaseRoutes(app, {
    bucket: () => bucket,
    scripts: { computer: COMPUTER_SCRIPT, daemon: DAEMON_SCRIPT },
  });
  // What the real app has after these routes: pages, which would answer 200.
  app.all("*", (c) => c.text("a page", 200));
  return { app, asked };
};

const published = {
  "releases/agentum/0.1.0+abc1234/agentum-linux-x64": BINARY,
  "releases/agentum/latest.json": '{"version":"0.1.0+abc1234"}',
  "releases/hm-computer/0.1.0+abc1234/hm-computer_linux_amd64": BINARY,
  "releases/secret/0.1.0+abc1234/agentum-linux-x64": "not for you",
  "releases/agentum/0.1.0+abc1234/notes.txt": "not a release file",
  "other/key": "private",
};

const get = (app: Hono<AppEnv>, path: string, headers?: HeadersInit) =>
  app.request(`${ORIGIN}${path}`, { headers });

describe("install scripts", () => {
  it("serves the daemon script with this origin filled in", async () => {
    const { app } = setup();
    const response = await get(app, "/install.sh");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await response.text()).toBe(`HM_ORIGIN="${ORIGIN}"\n# daemon`);
  });

  it("serves the computer script with this origin filled in", async () => {
    const { app } = setup();
    const response = await app.request(
      "http://localhost:8787/install-computer.sh"
    );
    expect(await response.text()).toBe(
      'HM_ORIGIN="http://localhost:8787"\n# computer'
    );
  });
});

describe("latest.json", () => {
  it("answers 404 before any release exists", async () => {
    const { app } = setup();
    const responses = await Promise.all(
      ["agentum", "hm-computer"].map((product) =>
        get(app, `/releases/${product}/latest.json`)
      )
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });

  it("serves the manifest as JSON with a short cache", async () => {
    const { app } = setup(published);
    const response = await get(app, "/releases/agentum/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await response.text()).toBe('{"version":"0.1.0+abc1234"}');
  });

  it("answers 404 for a product that does not exist", async () => {
    const { app, asked } = setup(published);
    const response = await get(app, "/releases/secret/latest.json");
    expect(response.status).toBe(404);
    expect(asked).toEqual([]);
  });
});

describe("release files", () => {
  it("streams a binary with length, ETag and an immutable cache header", async () => {
    const { app } = setup(published);
    const response = await get(
      app,
      "/releases/agentum/0.1.0+abc1234/agentum-linux-x64"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(BINARY.length));
    expect(response.headers.get("ETag")).toBe(`"etag-${BINARY.length}"`);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(await response.text()).toBe(BINARY);
  });

  it("serves a file by its URL-encoded plus sign too", async () => {
    const { app } = setup(published);
    const response = await get(
      app,
      "/releases/hm-computer/0.1.0%2Babc1234/hm-computer_linux_amd64"
    );
    expect(response.status).toBe(200);
  });

  it("answers 304 when the ETag matches", async () => {
    const { app } = setup(published);
    const response = await get(
      app,
      "/releases/agentum/0.1.0+abc1234/agentum-linux-x64",
      { "If-None-Match": `"etag-${BINARY.length}"` }
    );
    expect(response.status).toBe(304);
  });

  it("answers 404 for a known name that was never published", async () => {
    const { app } = setup(published);
    const response = await get(
      app,
      "/releases/agentum/0.1.0+abc1234/agentum-linux-arm64"
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 for a file name the product does not ship", async () => {
    const { app, asked } = setup(published);
    const responses = await Promise.all(
      [
        "/releases/agentum/0.1.0+abc1234/notes.txt",
        "/releases/agentum/0.1.0+abc1234/hm-computer_linux_amd64",
        "/releases/hm-computer/0.1.0+abc1234/agentum-linux-x64",
      ].map((path) => get(app, path))
    );
    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404,
    ]);
    expect(asked).toEqual([]);
  });

  it("never asks the bucket for a key outside the release prefix", async () => {
    const { app, asked } = setup(published);
    const attempts = [
      "/releases/agentum/..%2F..%2Fother/agentum-linux-x64",
      "/releases/agentum/0.1.0%2F..%2F..%2Fother%2Fkey/agentum-linux-x64",
      "/releases/agentum/0.1.0+abc1234/..%2Flatest.json",
      "/releases/agentum/0.1.0+abc1234/%2e%2e%2f%2e%2e%2fother%2Fkey",
      "/releases/agentum/%2e%2e/agentum-linux-x64",
      "/releases/agentum/0.1.0+abc1234/../../../other/key",
      "/releases/secret/0.1.0+abc1234/agentum-linux-x64",
      "/releases/..%2Fother/latest.json",
      "/releases/agentum/0.1.0+abc1234/agentum-linux-x64/extra",
      "/releases/other/key",
      "/releases/",
      "/releases",
    ];
    const bodies = await Promise.all(
      attempts.map(async (path) => (await get(app, path)).text())
    );
    for (const text of bodies) {
      expect(text).not.toContain("private");
      expect(text).not.toContain("not for you");
    }
    for (const key of asked) {
      expect(key.startsWith("releases/")).toBe(true);
      expect(key).not.toContain("..");
      expect(key).not.toContain("other");
      expect(key).not.toContain("secret");
    }
  });

  it("ends every path under /releases itself, so no page answers it", async () => {
    const { app } = setup(published);
    const responses = await Promise.all(
      ["/releases/nothing/here/at/all", "/releases/x"].map((path) =>
        get(app, path)
      )
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });
});
