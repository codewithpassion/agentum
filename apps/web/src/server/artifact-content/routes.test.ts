import { describe, expect, it } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { signViewToken } from "@repo/services/artifacts/view-token";
import { Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { BRIDGE_JS } from "./bridge.ts";
import { type ContentBucket, mountArtifactContentRoutes } from "./routes.ts";

const ORIGIN = "https://hm.test";
const KEY = "test-view-key";
const WORKSPACE = "ws_1";
const ARTIFACT = "6f1c2f0e-8f0e-4c3a-9f37-2b3f3c1d9a10";
const OTHER_ARTIFACT = "0b9f6a7e-3c1d-4d7e-8a55-6a1d9d5b7c22";
const VERSION = "ver_1";
const NOW = 1_800_000_000;

const sha = (char: string) => char.repeat(64);

interface Seed {
  entry: string;
  files: Record<string, { body: string; sha: string }>;
}

const PAGE: Seed = {
  entry: "index.html",
  files: {
    "app.js": { body: "console.log(1)", sha: sha("b") },
    "data.json": { body: '{"a":1}', sha: sha("c") },
    "index.html": {
      body: "<!doctype html><html><head><title>t</title></head><body>hi</body></html>",
      sha: sha("a"),
    },
    "sub/page.html": { body: "<p>no head</p>", sha: sha("d") },
    "weird.bin": { body: "xx", sha: sha("e") },
  },
};

const DOC: Seed = {
  entry: "index.md",
  files: { "index.md": { body: "# Hello\n\nworld", sha: sha("f") } },
};

const manifestJson = (seed: Seed) =>
  JSON.stringify({
    entry: seed.entry,
    files: Object.fromEntries(
      Object.entries(seed.files).map(([path, file]) => [
        path,
        {
          contentType: "text/plain",
          sha256: file.sha,
          size: file.body.length,
        },
      ])
    ),
  });

const makeBucket = (seed: Seed, versionId = VERSION) => {
  const objects = new Map<string, string>();
  objects.set(
    `${WORKSPACE}/artifact-manifests/${versionId}.json`,
    manifestJson(seed)
  );
  for (const file of Object.values(seed.files)) {
    objects.set(`${WORKSPACE}/artifact-blobs/${file.sha}`, file.body);
  }
  const reads: string[] = [];
  const bucket: ContentBucket = {
    get: (key) => {
      reads.push(key);
      const text = objects.get(key);
      if (text === undefined) {
        return Promise.resolve(null);
      }
      const bytes = new TextEncoder().encode(text);
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
        body: new Response(bytes).body as ReadableStream,
        size: bytes.length,
      });
    },
  };
  return { bucket, objects, reads };
};

const claims = (over: Partial<ViewTokenClaims> = {}): ViewTokenClaims => ({
  artifactId: ARTIFACT,
  expiresAt: NOW + 3600,
  userId: "user_1",
  versionId: VERSION,
  viewer: "member",
  ...over,
});

const token = (over: Partial<ViewTokenClaims> = {}, key = KEY) =>
  signViewToken(claims(over), key);

const setup = (seed: Seed = PAGE, workspaceId: string | null = WORKSPACE) => {
  const store = makeBucket(seed);
  const app = new Hono<AppEnv>();
  mountArtifactContentRoutes(app, {
    bucket: () => store.bucket,
    nowSeconds: () => NOW,
    viewKey: () => KEY,
    workspaceId: () => workspaceId,
  });
  const get = (
    path: string,
    init: RequestInit = {},
    origin = ORIGIN
  ): Response | Promise<Response> =>
    app.request(`${origin}${path}`, init, {} as Env);
  return { ...store, app, get };
};

const urlFor = (tok: string, path = "", artifact = ARTIFACT) =>
  `/a/${artifact}/c/${encodeURIComponent(tok)}/${path}`;

/** The exact CSP a content response carries for this content folder. */
const expectedCsp = (base: string | null, origin = ORIGIN) => {
  const b = base ? `${base} ` : "";
  const only = base ?? "'none'";
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src ${b}'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com`,
    `style-src ${b}'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${b}https://fonts.gstatic.com`,
    `img-src ${b}data: blob:`,
    `connect-src ${only}`,
    `media-src ${only}`,
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
};

const folder = (tok: string, artifact = ARTIFACT, origin = ORIGIN) =>
  `${origin}/a/${artifact}/c/${encodeURIComponent(tok)}/`;

// biome-ignore-start lint/suspicious/noMisplacedAssertion: reusable assertion called inside tests
const expectContentHeaders = (
  res: Response,
  base: string | null,
  origin = ORIGIN
) => {
  expect(res.headers.get("Content-Security-Policy")).toBe(
    expectedCsp(base, origin)
  );
  expect(res.headers.get("Content-Security-Policy")).not.toContain("'self'");
  expect(res.headers.get("Content-Security-Policy")).not.toContain(
    "allow-same-origin"
  );
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(res.headers.get("Service-Worker-Allowed")).toBeNull();
  expect(res.headers.get("Set-Cookie")).toBeNull();
  expect(res.headers.get("Vary")).toContain("Sec-Fetch-Dest");
};
// biome-ignore-end lint/suspicious/noMisplacedAssertion: reusable assertion

describe("content route: 200", () => {
  it("serves the entry for an empty path, with the full CSP", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectContentHeaders(res, folder(tok));
    expect(await res.text()).toContain("hi</body>");
  });

  it("injects the bridge script first in <head>", async () => {
    const { get } = setup();
    const tok = await token();
    const html = await (await get(urlFor(tok))).text();
    expect(html).toContain(
      '<head><script src="_hm/bridge.js"></script><title>t</title>'
    );
  });

  it("uses a path relative to the page for nested html, and appends without <head>", async () => {
    const { get } = setup();
    const tok = await token();
    const html = await (await get(urlFor(tok, "sub/page.html"))).text();
    expect(html).toContain('<script src="../_hm/bridge.js"></script>');
    expect(html).toContain("<p>no head</p>");
  });

  it("serves other files untouched with the content type from the map", async () => {
    const { get } = setup();
    const tok = await token();
    const js = await get(urlFor(tok, "app.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(await js.text()).toBe("console.log(1)");
    expectContentHeaders(js, folder(tok));
    const json = await get(urlFor(tok, "data.json"));
    expect(json.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8"
    );
    const bin = await get(urlFor(tok, "weird.bin"));
    expect(bin.headers.get("Content-Type")).toBe("application/octet-stream");
    expectContentHeaders(bin, folder(tok));
  });

  it("serves the bridge script and a doc page from _hm/", async () => {
    const { get } = setup();
    const tok = await token();
    const bridge = await get(urlFor(tok, "_hm/bridge.js"));
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(await bridge.text()).toBe(BRIDGE_JS);
    expectContentHeaders(bridge, folder(tok));
  });

  it("renders a markdown entry as a doc page (R1.21b)", async () => {
    const { get } = setup(DOC);
    const tok = await token();
    for (const path of ["", "_hm/doc.html"]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(urlFor(tok, path));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expectContentHeaders(res, folder(tok));
      const html = await res.text();
      expect(html).toContain("<h1>Hello</h1>");
      expect(html).toContain('<head><script src="');
    }
    const raw = await get(urlFor(tok, "index.md"));
    expect(raw.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(await raw.text()).toBe("# Hello\n\nworld");
  });

  it("answers HEAD with headers and no body", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok, "app.js"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expectContentHeaders(res, folder(tok));
  });

  it("reads only R2 keys under the workspace, manifest then blob", async () => {
    const { get, reads } = setup();
    const tok = await token();
    await get(urlFor(tok, "app.js"));
    expect(reads).toEqual([
      `${WORKSPACE}/artifact-manifests/${VERSION}.json`,
      `${WORKSPACE}/artifact-blobs/${sha("b")}`,
    ]);
  });

  it("scopes the CSP to the request origin (a preview host)", async () => {
    const { get } = setup();
    const tok = await token();
    const origin = "https://pr-7.example.workers.dev";
    const res = await get(urlFor(tok), {}, origin);
    expectContentHeaders(res, folder(tok, ARTIFACT, origin), origin);
  });
});

describe("content route: path edge cases", () => {
  it("answers 404 for names that exist on Object.prototype", async () => {
    const { get } = setup();
    const tok = await token();
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(urlFor(tok, name), {
        headers: { "If-None-Match": '"undefined"' },
      });
      expect(res.status).toBe(404);
      expectContentHeaders(res, folder(tok));
    }
  });

  it("injects the bridge once when a page has several <head> elements", async () => {
    const seed: Seed = {
      entry: "index.html",
      files: {
        "index.html": {
          body: "<html><head></head><body><svg><head></head></svg></body></html>",
          sha: sha("a"),
        },
      },
    };
    const tok = await token();
    const html = await (await setup(seed).get(urlFor(tok))).text();
    expect(html.match(/_hm\/bridge\.js/g)).toHaveLength(1);
  });

  it("redirects a document load before it considers If-None-Match", async () => {
    const { get } = setup();
    const tok = await token();
    const etag = (await get(urlFor(tok, "app.js"))).headers.get("ETag") ?? "";
    const res = await get(urlFor(tok, "app.js"), {
      headers: { "If-None-Match": etag, "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(302);
  });
});

describe("content route: 304", () => {
  it("answers a matching ETag with 304 and the full headers", async () => {
    const { get } = setup();
    const tok = await token();
    const first = await get(urlFor(tok, "app.js"));
    const etag = first.headers.get("ETag") ?? "";
    expect(etag).not.toBe("");
    const res = await get(urlFor(tok, "app.js"), {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expectContentHeaders(res, folder(tok));
  });

  it("304s the bridge script and html entries too", async () => {
    const { get, reads } = setup();
    const tok = await token();
    const bridgeEtag =
      (await get(urlFor(tok, "_hm/bridge.js"))).headers.get("ETag") ?? "";
    const bridge = await get(urlFor(tok, "_hm/bridge.js"), {
      headers: { "If-None-Match": bridgeEtag },
    });
    expect(bridge.status).toBe(304);
    const htmlEtag = (await get(urlFor(tok))).headers.get("ETag") ?? "";
    reads.length = 0;
    const html = await get(urlFor(tok), {
      headers: { "If-None-Match": `W/${htmlEtag}` },
    });
    expect(html.status).toBe(304);
    expect(reads).toHaveLength(1);
  });
});

describe("content route: 302 for a top-level open (R1.16)", () => {
  it("redirects a member token to /a/<uuid> without the token", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok), {
      headers: { "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/a/${ARTIFACT}`);
    expect(res.headers.get("Location")).not.toContain("hm_view_");
    expectContentHeaders(res, folder(tok));
  });

  it("redirects a link token, for any path", async () => {
    const { get } = setup();
    const tok = await token({
      shareId: "share_1",
      userId: undefined,
      viewer: "link",
    });
    const res = await get(urlFor(tok, "app.js"), {
      headers: { "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/a/${ARTIFACT}`);
    expectContentHeaders(res, folder(tok));
  });

  it("serves a test token even on a document load", async () => {
    const { get } = setup();
    const tok = await token({ userId: undefined, viewer: "test" });
    const res = await get(urlFor(tok), {
      headers: { "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(200);
    expectContentHeaders(res, folder(tok));
  });

  it("serves iframe and subresource loads", async () => {
    const { get } = setup();
    const tok = await token();
    for (const dest of ["iframe", "script", "image", "empty"]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(urlFor(tok), {
        headers: { "Sec-Fetch-Dest": dest },
      });
      expect(res.status).toBe(200);
    }
  });

  it("does not redirect a bad token, it refuses it", async () => {
    const { get } = setup();
    const res = await get(urlFor("hm_view_x.y"), {
      headers: { "Sec-Fetch-Dest": "document" },
    });
    expect(res.status).toBe(401);
  });
});

describe("content route: 401 and no bytes (R1.15)", () => {
  // biome-ignore-start lint/suspicious/noMisplacedAssertion: reusable assertion called inside tests
  const expectRefused = async (res: Response, tok: string) => {
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBeNull();
    expectContentHeaders(res, folder(tok));
  };
  // biome-ignore-end lint/suspicious/noMisplacedAssertion: reusable assertion

  it("refuses a token signed with another key", async () => {
    const { get } = setup();
    const tok = await token({}, "other-key");
    await expectRefused(await get(urlFor(tok)), tok);
  });

  it("refuses an expired token", async () => {
    const { get } = setup();
    const tok = await token({ expiresAt: NOW - 1 });
    await expectRefused(await get(urlFor(tok)), tok);
  });

  it("refuses a token for another artifact", async () => {
    const { get, reads } = setup();
    const tok = await token({ artifactId: OTHER_ARTIFACT });
    await expectRefused(await get(urlFor(tok)), tok);
    expect(reads).toEqual([]);
  });

  it("refuses garbage and tampered tokens", async () => {
    const { get } = setup();
    await expectRefused(await get(urlFor("garbage")), "garbage");
    const good = await token();
    const tampered = `${good.slice(0, -2)}AA`;
    await expectRefused(await get(urlFor(tampered)), tampered);
  });

  it("refuses a request with no token segment", async () => {
    const { get } = setup();
    for (const path of [
      `/a/${ARTIFACT}/c`,
      `/a/${ARTIFACT}/c/`,
      `/a/${ARTIFACT}/c//x`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
      expectContentHeaders(res, null);
    }
  });

  it("refuses before it reads R2 or the path", async () => {
    const { get, reads } = setup();
    const res = await get(urlFor("garbage", "app.js"));
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });
});

describe("content route: 403 for a service worker script", () => {
  it("answers 403 with the full headers, with or without a token", async () => {
    const { get } = setup();
    const tok = await token();
    for (const t of [tok, "garbage"]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(urlFor(t, "sw.js"), {
        headers: { "Service-Worker": "script" },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("Service-Worker-Allowed")).toBeNull();
      expectContentHeaders(res, folder(t));
    }
  });
});

describe("content route: 404", () => {
  it("answers 404 for a missing path", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok, "nope.html"));
    expect(res.status).toBe(404);
    expectContentHeaders(res, folder(tok));
  });

  it("answers 404 for unknown _hm/ files and dot segments", async () => {
    const { get } = setup();
    const tok = await token();
    for (const path of [
      "_hm/secret.txt",
      "_hm",
      "%2e%2e%2fx",
      "a%2Fb",
      "sub/",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: requests run in order
      const res = await get(urlFor(tok, path));
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Security-Policy")).toContain(
        "sandbox allow-scripts allow-forms"
      );
    }
  });

  it("answers 404 when the manifest, a blob or the workspace is missing", async () => {
    const tok = await token({ versionId: "other_version" });
    const missingManifest = await setup().get(urlFor(tok));
    expect(missingManifest.status).toBe(404);
    expectContentHeaders(missingManifest, folder(tok));

    const withoutBlob = setup();
    withoutBlob.objects.delete(`${WORKSPACE}/artifact-blobs/${sha("b")}`);
    const tok2 = await token();
    const blob = await withoutBlob.get(urlFor(tok2, "app.js"));
    expect(blob.status).toBe(404);
    expectContentHeaders(blob, folder(tok2));

    const noWorkspace = await setup(PAGE, null).get(urlFor(tok2));
    expect(noWorkspace.status).toBe(404);
    expectContentHeaders(noWorkspace, folder(tok2));
  });

  it("answers 404 for a path that is not a uuid", async () => {
    const { get } = setup();
    const res = await get("/a/not-a-uuid/c/sometoken/x");
    expect(res.status).toBe(404);
    expectContentHeaders(res, null);
  });
});

describe("content route: other statuses", () => {
  it("answers 405 for a write", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok), { method: "POST" });
    expect(res.status).toBe(405);
    expectContentHeaders(res, folder(tok));
  });

  it("answers a preflight with 204 and no credentials", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(urlFor(tok, "data.json"), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS"
    );
    expectContentHeaders(res, folder(tok));
  });

  it("redirects the folder URL without a trailing slash", async () => {
    const { get } = setup();
    const tok = await token();
    const res = await get(`/a/${ARTIFACT}/c/${encodeURIComponent(tok)}`);
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(urlFor(tok));
    expectContentHeaders(res, null);
  });

  it("answers 500 for a corrupt manifest, with the full headers", async () => {
    const { get, objects } = setup();
    objects.set(`${WORKSPACE}/artifact-manifests/${VERSION}.json`, "{not json");
    const tok = await token();
    const res = await get(urlFor(tok));
    expect(res.status).toBe(500);
    expectContentHeaders(res, folder(tok));
  });

  it("answers 500 with the full headers when the bucket throws", async () => {
    const app = new Hono<AppEnv>();
    mountArtifactContentRoutes(app, {
      bucket: () => ({
        get: () => Promise.reject(new Error("r2 down")),
      }),
      nowSeconds: () => NOW,
      viewKey: () => KEY,
      workspaceId: () => WORKSPACE,
    });
    const tok = await token();
    const res = await app.request(`${ORIGIN}${urlFor(tok)}`, {}, {} as Env);
    expect(res.status).toBe(500);
    expectContentHeaders(res, folder(tok));
  });

  it("answers 500 with the full headers when the workspace lookup throws", async () => {
    const app = new Hono<AppEnv>();
    mountArtifactContentRoutes(app, {
      bucket: () => makeBucket(PAGE).bucket,
      nowSeconds: () => NOW,
      viewKey: () => KEY,
      workspaceId: () => {
        throw new Error("d1 down");
      },
    });
    const tok = await token();
    const res = await app.request(`${ORIGIN}${urlFor(tok)}`, {}, {} as Env);
    expect(res.status).toBe(500);
    expectContentHeaders(res, folder(tok));
  });
});
