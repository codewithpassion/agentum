// File HTTP routes: the upload `POST /api/files` and the download
// `GET /files/:id`. A user (cookie session) or a run (`hm_run_` token, the
// daemon's) may call either. The services decide what each principal may
// read or write, so this file only authenticates and maps refusals to
// statuses. Mount with `runtimeRoutes.route("/", filesRoutes({ session }))`,
// because the paths are full, not prefixed.

import { MAX_FILE_BYTES } from "@repo/db/shared";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { FileRecord } from "@repo/services/files";
import {
  importRunTokenKey,
  RUN_TOKEN_PREFIX,
  verifyRunToken,
} from "@repo/services/run-tokens";
import { bearerToken, type Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./groups.ts";

/** Room for multipart boundaries and part headers on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_UPLOAD_BODY_BYTES = MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const TOO_LARGE = 413;
const CREATED = 201;

/**
 * Types a browser may render in place. Everything else, above all HTML, SVG
 * and XML (script), is served as a download.
 */
const INLINE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

/**
 * Served files run in a sandbox with nothing allowed but their own images
 * and inline styles, so even a file a browser renders cannot run script.
 */
const FILE_CSP_RULES =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
const FILE_CSP = `sandbox; ${FILE_CSP_RULES}`;
/**
 * PDFs drop `sandbox`: Chrome's PDF viewer does not run in a sandboxed
 * document, so the file would download instead of opening. PDF has no
 * script the browser runs, and `default-src 'none'` still applies.
 */
const PDF_CONTENT_TYPE = "application/pdf";

/** Anything outside printable ASCII, plus the two characters a quoted string cannot hold. */
const NON_ASCII_OR_QUOTE = /[^\x20-\x7E]|["\\]/g;
/** What `encodeURIComponent` leaves raw but an RFC 5987 ext-value does not allow. */
const EXT_VALUE_RESERVED = /['()*]/g;

export interface FilesRouteDeps {
  /** The Clerk session of the request: its user and active org, or null. */
  session: (
    c: Context<AppEnv>
  ) => { orgId?: string | null; userId: string | null } | null;
}

type RouteContext = Context<AppEnv>;

const extValue = (name: string): string =>
  encodeURIComponent(name).replace(
    EXT_VALUE_RESERVED,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

/** A Content-Disposition value: an ASCII fallback name plus the UTF-8 name. */
export const contentDisposition = (
  disposition: "inline" | "attachment",
  name: string
): string => {
  const fallback = name.replace(NON_ASCII_OR_QUOTE, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${extValue(name)}`;
};

/**
 * Headers for a stored file: safe disposition, no sniffing, sandboxing CSP,
 * private cache. No Range support: files are sent whole (200).
 */
export const fileResponseHeaders = (
  file: FileRecord
): Record<string, string> => {
  const contentType = file.mime;
  const disposition = INLINE_CONTENT_TYPES.has(contentType)
    ? "inline"
    : "attachment";
  return {
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": contentDisposition(disposition, file.name),
    "Content-Length": String(file.size),
    "Content-Security-Policy":
      contentType === PDF_CONTENT_TYPE ? FILE_CSP_RULES : FILE_CSP,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
};

/** Signals that an upload body ran past MAX_UPLOAD_BODY_BYTES. */
class BodyTooLargeError extends Error {}

/**
 * Parses the multipart body while counting its bytes, so a body without
 * Content-Length (chunked) is cut off at the limit instead of being
 * buffered whole first.
 */
const readLimitedForm = async (request: Request): Promise<FormData> => {
  if (!request.body) {
    throw new TypeError("Expected a request body");
  }
  let seen = 0;
  let tooLarge = false;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;
        if (seen > MAX_UPLOAD_BODY_BYTES) {
          tooLarge = true;
          controller.error(new BodyTooLargeError("upload too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
  try {
    return await new Response(counted, {
      headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
    }).formData();
  } catch (error: unknown) {
    throw tooLarge ? new BodyTooLargeError("upload too large") : error;
  }
};

const jsonError = (
  c: RouteContext,
  status: ContentfulStatusCode,
  error: string
) => c.json({ error }, status);

/**
 * The principal a `hm_run_` token names, or null. A missing key, a bad key or
 * a token that does not verify are all null, never a 500.
 */
export const runPrincipal = async (
  c: RouteContext,
  token: string
): Promise<Principal | null> => {
  if (!(token.startsWith(RUN_TOKEN_PREFIX) && c.env.RUN_TOKEN_KEY)) {
    return null;
  }
  let key: CryptoKey;
  try {
    key = await importRunTokenKey(c.env.RUN_TOKEN_KEY);
  } catch {
    return null;
  }
  const result = await verifyRunToken({
    db: c.get("composed").db,
    key,
    token,
  });
  if (!result.ok) {
    return null;
  }
  const { agentId, runId, workspaceId } = result.claims;
  return { agentId, kind: "run", runId, workspaceId };
};

/**
 * Who is calling. With an Authorization header, only a run token counts and
 * the cookie session is never consulted. Without one, the Clerk session.
 */
const authenticate = (
  c: RouteContext,
  deps: FilesRouteDeps
): Promise<Principal | null> => {
  const authorization = c.req.header("Authorization");
  if (authorization !== undefined) {
    const token = bearerToken(authorization);
    return token ? runPrincipal(c, token) : Promise.resolve(null);
  }
  const session = deps.session(c);
  if (!session?.userId) {
    return Promise.resolve(null);
  }
  return c.get("composed").services.workspaces.sessionPrincipal({
    orgId: session.orgId,
    userId: session.userId,
  });
};

const SIGN_IN = "Sign in required.";

/** Cross-site form posts are refused. Bearer requests carry no cookie, so they skip the check. */
const csrfUnlessBearer = (() => {
  const guard = csrf();
  return createMiddleware<AppEnv>((c, next) =>
    c.req.header("Authorization") === undefined ? guard(c, next) : next()
  );
})();

/** A refusal the services raised, as a response. Anything else is a bug and rethrows. */
const refusal = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return jsonError(c, FORBIDDEN, "Not allowed.");
  }
  if (isServiceError(error)) {
    return jsonError(c, error.status as ContentfulStatusCode, error.message);
  }
  throw error;
};

export const filesRoutes = (deps: FilesRouteDeps): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  routes.post("/api/files", csrfUnlessBearer, async (c) => {
    const principal = await authenticate(c, deps);
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, SIGN_IN);
    }
    // Refuse oversize bodies before reading them, when the length is known.
    const declared = Number(c.req.header("Content-Length") ?? Number.NaN);
    if (declared > MAX_UPLOAD_BODY_BYTES) {
      return jsonError(c, TOO_LARGE, "Files are limited to 50 MB.");
    }
    let form: FormData;
    try {
      form = await readLimitedForm(c.req.raw);
    } catch (error: unknown) {
      return error instanceof BodyTooLargeError
        ? jsonError(c, TOO_LARGE, "Files are limited to 50 MB.")
        : jsonError(
            c,
            BAD_REQUEST,
            "Expected multipart/form-data with a file field."
          );
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError(
        c,
        BAD_REQUEST,
        "Expected multipart/form-data with a file field."
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return jsonError(c, TOO_LARGE, "Files are limited to 50 MB.");
    }
    try {
      const record = await c.get("composed").services.files.upload(principal, {
        body: file,
        mime: file.type,
        name: file.name,
      });
      return c.json(record, CREATED);
    } catch (error: unknown) {
      return refusal(c, error);
    }
  });

  routes.get("/files/:id", async (c) => {
    const principal = await authenticate(c, deps);
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, SIGN_IN);
    }
    try {
      const { body, file } = await c
        .get("composed")
        .services.files.download(principal, c.req.param("id"));
      return new Response(body, { headers: fileResponseHeaders(file) });
    } catch (error: unknown) {
      // Every refusal reads the same, so a caller cannot tell a file that
      // exists from one it may not read.
      if (isForbiddenError(error) || isServiceError(error)) {
        return jsonError(c, NOT_FOUND, "Not found.");
      }
      throw error;
    }
  });

  return routes;
};
