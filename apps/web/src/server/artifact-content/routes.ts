// Content routes for artifacts: `GET /a/<uuid>/c/<token>/<path>` (PRD section
// 3). Reads the version's manifest and blobs from R2, checks the `ag_view_`
// token, then asks `authorizeViewer` whether its link or member is still valid
// (D1 and Clerk, on each request), and sends every response through
// `withContentHeaders`. Mounted by A.6 before the TanStack fall-through and
// outside Clerk and the compose middleware: `mountArtifactContentRoutes(app, deps)`.

import {
  type ContentCspInput,
  withContentHeaders,
} from "@repo/app-gateway/content-headers";
import {
  blobKey,
  type ContentBucket,
  type ContentObject,
  manifestKey,
} from "@repo/app-gateway/content-store";
import {
  type ArtifactManifest,
  artifactContentPath,
  artifactManifestSchema,
  contentTypeForPath,
  isReservedArtifactPath,
  parseArtifactContentPath,
  type ViewTokenClaims,
} from "@repo/protocol/artifacts";
import { verifyViewToken } from "@repo/services/artifacts/view-token";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import { BRIDGE_JS } from "./bridge.ts";
import { renderDocPage } from "./doc.ts";

const NOT_MODIFIED = 304;
const FOUND = 302;
const PERMANENT_REDIRECT = 308;
const NO_CONTENT = 204;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;
const SERVER_ERROR = 500;

const BRIDGE_PATH = "_hm/bridge.js";
const DOC_PATH = "_hm/doc.html";
const JS_TYPE = "text/javascript; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";
const PREFLIGHT_MAX_AGE_SECONDS = "86400";
const BARE_CONTENT_PATH = /^\/a\/[^/]+\/c\/[^/]+$/;
const TOKEN_SEGMENT = /^\/a\/[^/]+\/c\/[^/]+/;
const LEADING_WEAK = /^W\//;

export interface ArtifactContentDeps {
  /** The R2 bucket holding manifests and blobs (`env.FILES`). */
  authorizeGuestEmbed?: (claims: ViewTokenClaims, env: Env) => Promise<boolean>;
  /**
   * Re-checks a link or member token against the live share row or
   * membership, on every request. False answers 404, so a revoked link or a
   * removed member stops at once instead of when the token expires.
   */
  authorizeViewer?: (claims: ViewTokenClaims, env: Env) => Promise<boolean>;
  bucket: (env: Env) => ContentBucket;
  /** Test seam for the clock; defaults to the current time. */
  nowSeconds?: () => number;
  /** The HMAC key view tokens are signed with. */
  viewKey: (env: Env) => string;
  /**
   * The workspace that owns the artifact the token names. R2 keys start with
   * the workspace id (`<ws>/artifact-manifests/<versionId>.json`), but a view
   * token doesn't carry it, so the caller supplies it. Null makes the route
   * answer 404. A.6 can back this with a cached lookup or a token claim.
   */
  workspaceId: (
    claims: ViewTokenClaims,
    env: Env
  ) => string | null | Promise<string | null>;
}

const textResponse = (status: number, text: string | null = null): Response =>
  new Response(text, {
    headers: text ? { "Content-Type": "text/plain; charset=utf-8" } : {},
    status,
  });

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

let bridgeEtag: Promise<string> | null = null;
const bridgeEtagValue = (): Promise<string> => {
  bridgeEtag ??= sha256Hex(BRIDGE_JS).then((hash) => `"bridge-${hash}"`);
  return bridgeEtag;
};

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

/** `src` for the bridge script, relative to a document at `path`. */
const bridgeSrcFor = (path: string): string =>
  `${"../".repeat(path.split("/").length - 1)}${BRIDGE_PATH}`;

/**
 * Puts the bridge script before the first element of the page, whatever the
 * page looks like. The bridge must run before any script the artifact wrote:
 * it reads the nonce from `window.name`, and a page script that ran first could
 * change it, which blanks the frame. A script
 * before `<html>` or `<head>` lands in the implicit head, so this is valid
 * for pages with no `<head>`, or with scripts ahead of it.
 */
const injectBridge = (response: Response, src: string): Response => {
  const tag = `<script src="${src}"></script>`;
  let injected = false;
  // biome-ignore lint/correctness/noUndeclaredVariables: HTMLRewriter is a workerd and bun global
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        if (injected) {
          return;
        }
        injected = true;
        element.before(tag, { html: true });
      },
    })
    .onDocument({
      end(end) {
        // A page with no element at all.
        if (!injected) {
          end.append(tag, { html: true });
        }
      },
    })
    .transform(response);
};

interface ContentRequest {
  /** True for HEAD: same headers, no body. */
  head: boolean;
  headers: Headers;
  url: URL;
}

type FetchFile = (sha256: string) => Promise<ContentObject | null>;

const isMarkdown = (path: string): boolean =>
  path.toLowerCase().endsWith(".md");

const notFound = (): Response => textResponse(NOT_FOUND, "Not found");

const notModified = (etag: string): Response =>
  new Response(null, { headers: { ETag: etag }, status: NOT_MODIFIED });

/**
 * A markdown file as a page. `documentPath` is where the page itself is
 * served from, which decides the relative path of the bridge script.
 */
const serveDoc = async (
  manifest: ArtifactManifest,
  filePath: string,
  documentPath: string,
  fetchFile: FetchFile,
  request: ContentRequest
): Promise<Response> => {
  const file = Object.hasOwn(manifest.files, filePath)
    ? manifest.files[filePath]
    : undefined;
  if (!file) {
    return notFound();
  }
  const etag = `"${file.sha256}.doc"`;
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return notModified(etag);
  }
  const object = await fetchFile(file.sha256);
  if (!object) {
    return notFound();
  }
  const markdown = new TextDecoder().decode(await object.arrayBuffer());
  const html = renderDocPage(markdown, {
    bridgeSrc: bridgeSrcFor(documentPath),
  });
  return new Response(request.head ? null : html, {
    headers: { "Content-Type": HTML_TYPE, ETag: etag },
  });
};

/** One manifest file as stored, HTML with the bridge script injected. */
const serveFile = async (
  manifest: ArtifactManifest,
  filePath: string,
  documentPath: string,
  fetchFile: FetchFile,
  request: ContentRequest
): Promise<Response> => {
  const file = Object.hasOwn(manifest.files, filePath)
    ? manifest.files[filePath]
    : undefined;
  if (!file) {
    return notFound();
  }
  const contentType = contentTypeForPath(filePath);
  const isHtml = contentType.startsWith("text/html");
  const etag = isHtml ? `"${file.sha256}.b2"` : `"${file.sha256}"`;
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return notModified(etag);
  }
  const object = await fetchFile(file.sha256);
  if (!object) {
    return notFound();
  }
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ETag: etag,
  };
  if (request.head) {
    return new Response(null, { headers });
  }
  if (isHtml) {
    return injectBridge(
      new Response(object.body, { headers }),
      bridgeSrcFor(documentPath)
    );
  }
  headers["Content-Length"] = String(object.size);
  return new Response(object.body, { headers });
};

const serveBridge = async (request: ContentRequest): Promise<Response> => {
  const etag = await bridgeEtagValue();
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return notModified(etag);
  }
  return new Response(request.head ? null : BRIDGE_JS, {
    headers: { "Content-Type": JS_TYPE, ETag: etag },
  });
};

const readManifest = async (
  object: ContentObject
): Promise<ArtifactManifest | null> => {
  try {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(await object.arrayBuffer())
    );
    const parsed = artifactManifestSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The file a request path names, once the token and the manifest are good. */
const serveVersion = (
  manifest: ArtifactManifest,
  path: string,
  fetchFile: FetchFile,
  request: ContentRequest
): Promise<Response> | Response => {
  if (path === DOC_PATH) {
    const docEntry = isMarkdown(manifest.entry) ? manifest.entry : "index.md";
    return serveDoc(manifest, docEntry, path, fetchFile, request);
  }
  if (isReservedArtifactPath(path)) {
    return notFound();
  }
  if (path === "") {
    const { entry } = manifest;
    return isMarkdown(entry)
      ? serveDoc(manifest, entry, "", fetchFile, request)
      : serveFile(manifest, entry, "", fetchFile, request);
  }
  return serveFile(manifest, path, path, fetchFile, request);
};

const allowsEmbedFile = (
  claims: ViewTokenClaims,
  manifest: ArtifactManifest,
  path: string,
  destination: string | undefined
): boolean => {
  if (claims.embedFile) {
    if (
      ["iframe", "frame", "document"].includes(destination ?? "") &&
      path !== claims.embedFile.path
    ) {
      return false;
    }
    const file = manifest.files[claims.embedFile.path];
    if (
      !file ||
      file.sha256 !== claims.embedFile.sha256 ||
      !contentTypeForPath(claims.embedFile.path).startsWith("text/html")
    ) {
      return false;
    }
    // Relative assets remain scoped to the signed version; alternate HTML pages are refused.
    if (
      path !== claims.embedFile.path &&
      contentTypeForPath(path).startsWith("text/html")
    ) {
      return false;
    }
    if (path === "" || path === DOC_PATH) {
      return false;
    }
  }
  return true;
};

/**
 * Everything but the headers: the refusals in order, then the file. Fills
 * `csp` as soon as the URL parses so the wrapper can scope the CSP to the
 * content folder, even on the error paths after that.
 */
const tokenRefusal = async (
  claims: ViewTokenClaims,
  env: Env,
  deps: ArtifactContentDeps,
  csp: ContentCspInput
): Promise<Response | null> => {
  if (claims.guestEmbed && !(await deps.authorizeGuestEmbed?.(claims, env))) {
    return textResponse(FORBIDDEN);
  }
  if (!((await deps.authorizeViewer?.(claims, env)) ?? true)) {
    csp.noStore = true;
    return notFound();
  }
  return null;
};

const respond = async (
  c: Context<AppEnv>,
  deps: ArtifactContentDeps,
  csp: ContentCspInput
): Promise<Response> => {
  const url = new URL(c.req.url);
  const { pathname } = url;
  const { method } = c.req;
  const parsed = parseArtifactContentPath(pathname);
  if (parsed) {
    csp.contentBase = `${url.origin}${artifactContentPath({
      artifactId: parsed.artifactId,
      token: parsed.token,
    })}`;
  }

  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Max-Age": PREFLIGHT_MAX_AGE_SECONDS,
      },
      status: NO_CONTENT,
    });
  }
  if (c.req.header("Service-Worker") === "script") {
    return textResponse(FORBIDDEN);
  }
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, {
      headers: { Allow: "GET, HEAD, OPTIONS" },
      status: METHOD_NOT_ALLOWED,
    });
  }
  if (BARE_CONTENT_PATH.test(pathname)) {
    // Relative URLs in the page need the trailing slash.
    return new Response(null, {
      headers: { Location: `${pathname}/${url.search}` },
      status: PERMANENT_REDIRECT,
    });
  }
  if (!parsed) {
    // No token segment at all is a missing token, not a missing page.
    return TOKEN_SEGMENT.test(pathname)
      ? notFound()
      : textResponse(UNAUTHORIZED);
  }

  const claims = await verifyViewToken(
    parsed.token,
    deps.viewKey(c.env),
    deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000)
  );
  if (!claims || claims.artifactId !== parsed.artifactId) {
    return textResponse(UNAUTHORIZED);
  }
  csp.noStore = Boolean(claims.guestEmbed);
  const refusal = await tokenRefusal(claims, c.env, deps, csp);
  if (refusal) {
    return refusal;
  }
  if (
    c.req.header("Sec-Fetch-Dest") === "document" &&
    claims.viewer !== "test"
  ) {
    return new Response(null, {
      headers: { Location: `/a/${parsed.artifactId}` },
      status: FOUND,
    });
  }

  const request: ContentRequest = {
    head: method === "HEAD",
    headers: c.req.raw.headers,
    url,
  };
  if (parsed.path === BRIDGE_PATH) {
    return serveBridge(request);
  }
  const workspaceId = await deps.workspaceId(claims, c.env);
  if (!workspaceId) {
    return notFound();
  }
  const bucket = deps.bucket(c.env);
  const manifestObject = await bucket.get(
    manifestKey(workspaceId, claims.versionId)
  );
  if (!manifestObject) {
    return notFound();
  }
  const manifest = await readManifest(manifestObject);
  if (!manifest) {
    return textResponse(SERVER_ERROR, "Bad manifest");
  }
  if (
    !allowsEmbedFile(
      claims,
      manifest,
      parsed.path,
      c.req.header("Sec-Fetch-Dest")
    )
  ) {
    return notFound();
  }
  return serveVersion(
    manifest,
    parsed.path,
    (sha256) => bucket.get(blobKey(workspaceId, sha256)),
    request
  );
};

/**
 * Mount the content routes on `app`. Every response, including a thrown
 * error, leaves through `withContentHeaders`.
 */
export const mountArtifactContentRoutes = (
  app: Hono<AppEnv>,
  deps: ArtifactContentDeps
): void => {
  const handler = async (c: Context<AppEnv>): Promise<Response> => {
    const csp: ContentCspInput = {
      appOrigin: new URL(c.req.url).origin,
      contentBase: null,
    };
    let response: Response;
    try {
      response = await respond(c, deps, csp);
    } catch {
      response = textResponse(SERVER_ERROR, "Error");
    }
    return withContentHeaders(response, csp);
  };
  app.all("/a/:id/c", handler);
  app.all("/a/:id/c/*", handler);
};
