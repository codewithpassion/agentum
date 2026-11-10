// Library HTTP route: `GET /api/library/download?path=<library path>`, the
// cookie-session download for files too big for the text view on /library.
// Only a signed-in user may call it. The service decides what the principal
// may read, so this file only authenticates and maps refusals to statuses.
// Mount with `runtimeRoutes.route("/", libraryRoutes({ session }))`, because
// the path is full, not prefixed.

import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { Hono } from "hono";
import { contentDisposition } from "./files.ts";
import type { AppEnv } from "./groups.ts";
import { type SessionDeps, sessionUser } from "./respond.ts";

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

export type LibraryRouteDeps = SessionDeps;

const SIGN_IN = "Sign in required.";

/** The last segment of a library path, which names the download. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const libraryRoutes = (deps: LibraryRouteDeps): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  routes.get("/api/library/download", async (c) => {
    const principal = await sessionUser(c, deps);
    if (!principal) {
      return c.json({ error: SIGN_IN }, UNAUTHORIZED);
    }
    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "Expected a path query parameter." }, BAD_REQUEST);
    }
    try {
      const { bytes, entry } = await c
        .get("composed")
        .services.library.read(principal, path);
      // The store hands over bytes backed by an ArrayBuffer, which is what a
      // Response body takes. The type only says ArrayBufferLike.
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(
            "attachment",
            nameOf(entry.path)
          ),
          "Content-Length": String(bytes.byteLength),
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error: unknown) {
      // Every refusal reads the same, so a caller cannot tell a file that
      // exists from one it may not read.
      if (isForbiddenError(error) || isServiceError(error)) {
        return c.json({ error: "Not found." }, NOT_FOUND);
      }
      throw error;
    }
  });

  return routes;
};
