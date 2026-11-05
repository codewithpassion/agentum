/**
 * The `AppGateway` (PRD section 5): a request for
 * `/a/<uuid>/c/<token>/api/*` plus the claims of its verified view token goes
 * to the version's server part, and the answer goes back through the header
 * rules. The route that verifies the token is B.8's. Everything this needs
 * from other tasks comes in as a port.
 */
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import type { AppErrorTarget } from "@repo/services/artifacts/errors";
import { readCappedBody } from "../mcp/body.ts";
import {
  filteredResponse,
  forwardedRequestHeaders,
  preflightResponse,
} from "./headers.ts";
import type { AppGatewayPorts, AppRuntime, AppRuntimeInput } from "./ports.ts";
import type { AppHostViewer, AppRequestMeta } from "./types.ts";

/** The most of a request body the gateway passes on. */
export const MAX_APP_REQUEST_BYTES = 5 * 1024 * 1024;
/** Wall time for one request. The CPU limit is not enforced in local dev, so a timer backs it. */
export const APP_WALL_MS = 30_000;

/** Body of every refusal the gateway makes itself. Never the app's message. */
const BAD_GATEWAY_BODY = "The app's server could not answer.";
const TIMEOUT_BODY = "The app's server took too long.";
const NOT_FOUND_BODY = "Not found.";
const UNAUTHORIZED_BODY = "Unauthorized.";
const LINK_GONE_BODY = "This link is no longer available.";

/** `/a/<uuid>/c/<token>` then `/api` and anything below it. */
const ENDPOINT_PREFIX = /^\/hooks\/[^/]+/;
const API_PATH = /^\/a\/[^/]+\/c\/[^/]+(\/api(?:\/.*)?)$/;

export interface AppGatewayDeps {
  /** The A.4 content wrapper: CSP, nosniff and the rest, set on every answer. */
  applyContentHeaders: (response: Response) => Response;
  defer?: (work: Promise<void>) => void;
  ports: Pick<AppGatewayPorts, "shares" | "source">;
  recordError?: (
    target: AppErrorTarget,
    entry: string,
    error: unknown
  ) => Promise<void>;
  /** The visitor hash and request details for R2.13 and R2.14 (the hash uses A.3's daily salt). */
  requestMeta: (
    request: Request,
    workspaceId: string
  ) => Promise<AppRequestMeta>;
  runtime: AppRuntime;
  wallMs?: number;
}

const text = (status: number, body: string): Response =>
  new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status,
  });

type ViewerResult =
  | { ok: true; viewer: AppHostViewer }
  | { ok: false; response: Response };

const viewerOf = async (
  claims: ViewTokenClaims,
  deps: AppGatewayDeps
): Promise<ViewerResult> => {
  if (claims.viewer === "test") {
    return { ok: true, viewer: { kind: "test" } };
  }
  if (claims.viewer === "member") {
    return claims.userId
      ? { ok: true, viewer: { kind: "member", userId: claims.userId } }
      : { ok: false, response: text(401, UNAUTHORIZED_BODY) };
  }
  if (!claims.shareId) {
    return { ok: false, response: text(401, UNAUTHORIZED_BODY) };
  }
  const share = await deps.ports.shares.state(
    claims.shareId,
    claims.artifactId
  );
  return share.ok
    ? {
        ok: true,
        viewer: {
          dataMode: share.dataMode,
          kind: "link",
          shareId: claims.shareId,
        },
      }
    : { ok: false, response: text(403, LINK_GONE_BODY) };
};

/** The request the app sees: path from `/api` on with the query, no token, no cookies. */
const forwardedRequest = async (
  request: Request,
  path: string,
  keepAuthorization = false
): Promise<Request | Response> => {
  const url = new URL(request.url);
  const target = new URL(`${path}${url.search}`, url.origin);
  const headers = forwardedRequestHeaders(request.headers, keepAuthorization);
  if (request.method === "GET" || request.method === "HEAD") {
    return new Request(target, { headers, method: request.method });
  }
  const read = await readCappedBody(request, MAX_APP_REQUEST_BYTES);
  if (!read.ok) {
    return text(read.status, read.error);
  }
  // The length is recomputed from the bytes.
  headers.delete("content-length");
  return new Request(target, {
    body: read.bytes,
    headers,
    method: request.method,
  });
};

const timer = (ms: number) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { clear: () => clearTimeout(handle), expired };
};

const recordError = (
  input: AppRuntimeInput,
  deps: AppGatewayDeps,
  entry: string,
  error: unknown
): void => {
  const work = Promise.resolve()
    .then(() => deps.recordError?.(input.host, entry, error))
    .catch(() => undefined);
  deps.defer?.(work);
};

const runApp = async (
  input: AppRuntimeInput,
  deps: AppGatewayDeps,
  entry = "fetch page"
): Promise<Response> => {
  const wall = timer(deps.wallMs ?? APP_WALL_MS);
  try {
    const answer = await Promise.race([
      deps.runtime.handle({
        ...input,
        background: {
          defer: (work) => deps.defer?.(work),
          onError: (error) =>
            Promise.resolve()
              .then(() =>
                deps.recordError?.(
                  input.host,
                  `waitUntil ${entry.slice("fetch ".length)}`,
                  error
                )
              )
              .catch(() => undefined),
        },
      }),
      wall.expired,
    ]);
    if (answer === "timeout") {
      recordError(input, deps, entry, new Error("timed out"));
      return text(504, TIMEOUT_BODY);
    }
    return filteredResponse(answer);
  } catch (error) {
    recordError(input, deps, entry, error);
    return text(502, BAD_GATEWAY_BODY);
  } finally {
    wall.clear();
  }
};

/** Every answer, success, refusal or error, leaves through the content headers. */
const finished = (response: Response, deps: AppGatewayDeps): Response => {
  const wrapped = deps.applyContentHeaders(response);
  // Copied so a wrapper that returns immutable headers cannot make this throw.
  const answer = new Response(wrapped.body, {
    headers: new Headers(wrapped.headers),
    status: wrapped.status,
  });
  // Live data must not sit in the browser's cache for the wrapper's five minutes.
  answer.headers.set("Cache-Control", "private, no-store");
  return answer;
};

const serve = async (
  request: Request,
  claims: ViewTokenClaims,
  deps: AppGatewayDeps
): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return finished(preflightResponse(request), deps);
  }
  const path = API_PATH.exec(new URL(request.url).pathname)?.[1];
  if (!path) {
    return finished(text(404, NOT_FOUND_BODY), deps);
  }
  const { workspaceId } = claims;
  const viewer = await viewerOf(claims, deps);
  if (!viewer.ok) {
    return finished(viewer.response, deps);
  }
  const forwarded = await forwardedRequest(request, path);
  if (forwarded instanceof Response) {
    return finished(forwarded, deps);
  }
  const answer = await runApp(
    {
      bundle: (artifactId, versionId) =>
        deps.ports.source.bundle(artifactId, versionId),
      host: {
        artifactId: claims.artifactId,
        meta: await deps.requestMeta(request, workspaceId),
        versionId: claims.versionId,
        viewer: viewer.viewer,
        workspaceId,
      },
      request: forwarded,
    },
    deps
  );
  return finished(answer, deps);
};

/** The gateway's one entry. `claims` come from a verified view token that names this artifact. A failing port answers 502 through the content headers like any other answer. */
export const handleAppRequest = async (
  request: Request,
  claims: ViewTokenClaims,
  deps: AppGatewayDeps
): Promise<Response> => {
  try {
    return await serve(request, claims, deps);
  } catch {
    return finished(text(502, BAD_GATEWAY_BODY), deps);
  }
};

/** Public ingress shares the runtime and byte-preserving gateway, with no view token or preflight shortcut. */
export const handleEndpointRequest = async (
  request: Request,
  endpoint: {
    artifactId: string;
    versionId: string;
    workspaceId: string;
    endpointId: string;
    name?: string;
  },
  deps: AppGatewayDeps
): Promise<Response> => {
  try {
    const path =
      new URL(request.url).pathname.replace(ENDPOINT_PREFIX, "") || "/";
    const forwarded = await forwardedRequest(request, path, true);
    if (forwarded instanceof Response) {
      return finished(forwarded, deps);
    }
    return finished(
      await runApp(
        {
          bundle: (artifactId, versionId) =>
            deps.ports.source.bundle(artifactId, versionId),
          host: {
            artifactId: endpoint.artifactId,
            meta: await deps.requestMeta(request, endpoint.workspaceId),
            versionId: endpoint.versionId,
            viewer: { endpointId: endpoint.endpointId, kind: "endpoint" },
            workspaceId: endpoint.workspaceId,
          },
          request: forwarded,
        },
        deps,
        `fetch ${endpoint.name ?? endpoint.endpointId}`
      ),
      deps
    );
  } catch {
    return finished(text(502, BAD_GATEWAY_BODY), deps);
  }
};
