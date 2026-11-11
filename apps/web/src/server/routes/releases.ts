// Public routes for the Agentum client releases. No sign-in: like Bun's
// installer, `curl <origin>/install.sh | sh` has no session. The binaries hold
// no secrets (the credential comes from `enroll`). Mounted before Clerk, so no
// Clerk redirect can catch them, and every path under `/releases` ends here.
//
//   GET /install-agentum.sh                 the script with this origin in it
//   GET /install.sh, /install-computer.sh   retired: a script that prints the new command
//   GET /releases/<product>/latest.json     the manifest the publish script wrote last
//   GET /releases/<product>/<version>/<file>  a binary, streamed from R2

import type { Context, Hono } from "hono";
import {
  renderInstallScript,
  retiredInstallScript,
} from "../releases/install-script.ts";
import {
  fileKey,
  isProduct,
  isReleaseFile,
  manifestKey,
} from "../releases/manifest.ts";
import type { ReleaseBucket } from "../releases/store.ts";
import type { AppEnv } from "./groups.ts";

const NOT_FOUND = 404;
const NOT_MODIFIED = 304;
const SCRIPT_CACHE = "public, max-age=60";
const MANIFEST_CACHE = "public, max-age=60";
const FILE_CACHE = "public, max-age=31536000, immutable";
const LEADING_WEAK = /^W\//;

export interface ReleaseRoutesDeps {
  bucket: (env: Env) => ReleaseBucket;
  /** The install script as a file, with the origin placeholder still in it. */
  scripts: { agentum: string };
}

const notFound = (): Response =>
  new Response("Not found", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status: NOT_FOUND,
  });

/** True when `If-None-Match` names `etag` (weak comparison) or is `*`. */
const etagMatches = (header: string | null, etag: string): boolean => {
  if (!header) {
    return false;
  }
  return header
    .split(",")
    .map((part) => part.trim().replace(LEADING_WEAK, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
};

const scriptResponse = (body: string): Response =>
  new Response(body, {
    headers: {
      "Cache-Control": SCRIPT_CACHE,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

const originOf = (c: Context<AppEnv>): string => new URL(c.req.url).origin;

export const mountReleaseRoutes = (
  app: Hono<AppEnv>,
  deps: ReleaseRoutesDeps
): void => {
  app.get("/install-agentum.sh", (c) =>
    scriptResponse(renderInstallScript(deps.scripts.agentum, originOf(c)))
  );
  for (const retired of ["/install.sh", "/install-computer.sh"]) {
    app.get(retired, (c) => scriptResponse(retiredInstallScript(originOf(c))));
  }

  app.get("/releases/:product/latest.json", async (c) => {
    const product = c.req.param("product");
    if (!isProduct(product)) {
      return notFound();
    }
    const object = await deps.bucket(c.env).get(manifestKey(product));
    if (!object) {
      return notFound();
    }
    return new Response(object.body, {
      headers: {
        "Cache-Control": MANIFEST_CACHE,
        "Content-Length": String(object.size),
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  });

  app.get("/releases/:product/:version/:file", async (c) => {
    const { file, product, version } = c.req.param();
    if (!(isProduct(product) && isReleaseFile(product, version, file))) {
      return notFound();
    }
    const object = await deps
      .bucket(c.env)
      .get(fileKey(product, version, file));
    if (!object) {
      return notFound();
    }
    const headers = {
      "Cache-Control": FILE_CACHE,
      ETag: object.httpEtag,
    };
    if (etagMatches(c.req.header("If-None-Match") ?? null, object.httpEtag)) {
      return new Response(null, { headers, status: NOT_MODIFIED });
    }
    return new Response(object.body, {
      headers: {
        ...headers,
        "Content-Disposition": `attachment; filename="${file}"`,
        "Content-Length": String(object.size),
        "Content-Type": "application/octet-stream",
      },
    });
  });

  // Anything else under /releases is not a release. Answer here so it never
  // falls through to Clerk or the pages.
  app.all("/releases/*", () => notFound());
};
