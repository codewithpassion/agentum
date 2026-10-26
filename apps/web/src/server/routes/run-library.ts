// Library HTTP routes for the daemon. Two prefixes serve the same handlers:
// `/api/runs/:id/library` takes a run token (`hm_run_`, bearer) that must name
// the run in the URL, and `/api/session/library` takes a run or managed
// session token (`hm_run_` or `hm_ses_`, bearer) and checks no run id, because
// a managed session's run changes every turn. `/api/session/library/run` answers
// the id of the run the token names. The cookie session is never read. The
// services decide what the caller may do, so this file only authenticates and
// maps refusals to statuses. Mount with `runtimeRoutes.route("/", runLibraryRoutes())`,
// because the paths are full, not prefixed.

import {
  LIBRARY_ETAG_HEADER,
  LIBRARY_IF_ETAG_HEADER,
  type LibraryEntryWire,
  libraryConflictRequestSchema,
  libraryListResponseSchema,
  libraryStatResponseSchema,
  libraryWriteResponseSchema,
} from "@repo/protocol/library";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { LibraryEntry } from "@repo/services/library";
import { importRunTokenKey, verifyAgentToken } from "@repo/services/run-tokens";
import { bearerToken, type Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runPrincipal } from "./files.ts";
import type { AppEnv } from "./groups.ts";

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

const INVALID_TOKEN = "Invalid run token.";
const NOT_ALLOWED = "Not allowed.";
const PATH_REQUIRED = "Expected a path query parameter.";
const CONFLICT_BODY = "Expected JSON with path and conflictPath.";

type RouteContext = Context<AppEnv>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;
type RunHandler = (
  c: RouteContext,
  principal: RunPrincipal
) => Promise<Response>;
type Authenticate = (
  c: RouteContext,
  token: string
) => Promise<RunPrincipal | null>;

const jsonError = (
  c: RouteContext,
  status: ContentfulStatusCode,
  error: string
) => c.json({ error }, status);

/** A refusal the services raised, as a response. Anything else is a bug and rethrows. */
const refusal = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return jsonError(c, FORBIDDEN, NOT_ALLOWED);
  }
  if (isServiceError(error)) {
    return jsonError(c, error.status as ContentfulStatusCode, error.message);
  }
  throw error;
};

/**
 * Wraps a handler in a bearer check. The token must authenticate, and `mayUse`
 * must allow that run for this URL. The handler gets the authenticated run.
 */
const guarded =
  (
    authenticate: Authenticate,
    mayUse: (c: RouteContext, principal: RunPrincipal) => boolean
  ) =>
  (handler: RunHandler) =>
  async (c: RouteContext): Promise<Response> => {
    const token = bearerToken(c.req.header("Authorization") ?? null);
    const principal = token ? await authenticate(c, token) : null;
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, INVALID_TOKEN);
    }
    if (!mayUse(c, principal)) {
      return jsonError(c, FORBIDDEN, NOT_ALLOWED);
    }
    try {
      return await handler(c, principal);
    } catch (error: unknown) {
      return refusal(c, error);
    }
  };

/** A run token that names the run in the `:id` URL parameter. */
const runRoute = guarded(
  async (c, token) => {
    const principal = await runPrincipal(c, token);
    return principal?.kind === "run" ? principal : null;
  },
  (c, principal) => principal.runId === c.req.param("id")
);

/** A run or managed session token. The run it names is whatever is live now. */
const sessionRoute = guarded(
  async (c, token) => {
    if (!c.env.RUN_TOKEN_KEY) {
      return null;
    }
    let key: CryptoKey;
    try {
      key = await importRunTokenKey(c.env.RUN_TOKEN_KEY);
    } catch {
      return null;
    }
    const result = await verifyAgentToken({
      db: c.get("composed").db,
      key,
      token,
    });
    if (!result.ok) {
      return null;
    }
    const { agentId, runId, workspaceId } = result.claims;
    return { agentId, kind: "run", runId, workspaceId };
  },
  () => true
);

/** The `path` query parameter, or null when it is absent. An empty string is the root. */
const pathParam = (c: RouteContext): string | null =>
  c.req.query("path") ?? null;

/** A file's etag. Only folders have none, and the services always return one for a file. */
const etagOf = (entry: LibraryEntry): string => {
  if (entry.etag === null) {
    throw new Error(`Library file ${entry.path} has no etag.`);
  }
  return entry.etag;
};

const wireEntry = ({
  etag,
  kind,
  path,
  size,
}: LibraryEntry): LibraryEntryWire => ({ etag, kind, path, size });

/** The six library routes under `base`, each behind `guard`. */
const registerLibraryRoutes = (
  routes: Hono<AppEnv>,
  base: string,
  guard: (handler: RunHandler) => (c: RouteContext) => Promise<Response>
) => {
  routes.get(
    `${base}/list`,
    guard(async (c, principal) => {
      const path = pathParam(c);
      if (path === null) {
        return jsonError(c, BAD_REQUEST, PATH_REQUIRED);
      }
      const entries = await c
        .get("composed")
        .services.library.list(principal, path);
      return c.json(
        libraryListResponseSchema.parse({ entries: entries.map(wireEntry) })
      );
    })
  );

  routes.get(
    `${base}/stat`,
    guard(async (c, principal) => {
      const path = pathParam(c);
      if (path === null) {
        return jsonError(c, BAD_REQUEST, PATH_REQUIRED);
      }
      const entry = await c
        .get("composed")
        .services.library.stat(principal, path);
      return c.json(
        libraryStatResponseSchema.parse({ entry: wireEntry(entry) })
      );
    })
  );

  routes.get(
    `${base}/file`,
    guard(async (c, principal) => {
      const path = pathParam(c);
      if (path === null) {
        return jsonError(c, BAD_REQUEST, PATH_REQUIRED);
      }
      const { bytes, entry } = await c
        .get("composed")
        .services.library.read(principal, path);
      // The store hands over bytes backed by an ArrayBuffer, which is what a
      // Response body takes. The type only says ArrayBufferLike.
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          [LIBRARY_ETAG_HEADER]: etagOf(entry),
        },
      });
    })
  );

  routes.put(
    `${base}/file`,
    guard(async (c, principal) => {
      const path = pathParam(c);
      if (path === null) {
        return jsonError(c, BAD_REQUEST, PATH_REQUIRED);
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const ifEtag = c.req.header(LIBRARY_IF_ETAG_HEADER);
      const entry = await c
        .get("composed")
        .services.library.write(
          principal,
          path,
          bytes,
          ifEtag === undefined ? undefined : { ifEtag }
        );
      return c.json(libraryWriteResponseSchema.parse({ etag: etagOf(entry) }));
    })
  );

  routes.delete(
    `${base}/file`,
    guard(async (c, principal) => {
      const path = pathParam(c);
      if (path === null) {
        return jsonError(c, BAD_REQUEST, PATH_REQUIRED);
      }
      await c.get("composed").services.library.remove(principal, path);
      return c.json({});
    })
  );

  routes.post(
    `${base}/conflicts`,
    guard(async (c, principal) => {
      const parsed = libraryConflictRequestSchema.safeParse(
        await c.req.json<unknown>().catch(() => null)
      );
      if (!parsed.success) {
        return jsonError(c, BAD_REQUEST, CONFLICT_BODY);
      }
      await c
        .get("composed")
        .services.library.recordConflict(principal, parsed.data);
      return c.json({});
    })
  );
};

export const runLibraryRoutes = (): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  registerLibraryRoutes(routes, "/api/runs/:id/library", runRoute);
  registerLibraryRoutes(routes, "/api/session/library", sessionRoute);

  routes.get(
    "/api/session/library/run",
    sessionRoute((c, principal) =>
      Promise.resolve(c.json({ runId: principal.runId }))
    )
  );

  return routes;
};
