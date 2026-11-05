/**
 * The route for `/a/<uuid>/c/<token>/api/*` (PRD section 5). It verifies the
 * view token, checks that the path names the token's artifact, applies the
 * rule for snapshot-link and test viewers (R2.6), then hands the request to
 * the gateway. Mounted in `server.ts` before the content routes, which would
 * answer 405 to a POST. Every answer leaves through `withContentHeaders`.
 */

import {
  type ContentCspInput,
  withContentHeaders,
} from "@repo/app-gateway/content-headers";
import type {
  ApiLimiter,
  AppGatewayWiring,
} from "@repo/app-gateway/gateway-core";
import { handleAppRequest } from "@repo/app-gateway/gateway-core";
import {
  artifactContentPath,
  parseArtifactContentPath,
  type ViewTokenClaims,
} from "@repo/protocol/artifacts";
import { truncateIp } from "@repo/services/artifacts/view-privacy";
import { verifyViewToken } from "@repo/services/artifacts/view-token";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

export interface AppGatewayMountDeps {
  /** Flood guard for link holders, counted per link and per IP prefix. Without it nothing is counted. */
  limiter?: (env: Env) => ApiLimiter | undefined;
  /** Test seam for the clock; defaults to the current time. */
  nowSeconds?: () => number;
  /** The HMAC key view tokens are signed with. */
  viewKey: (env: Env) => string;
  wiring: (c: Context<AppEnv>) => AppGatewayWiring;
}

const text = (status: number, body: string): Response =>
  new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status,
  });

/**
 * Whether the request is one the app may not serve. `AppOutbound` is per
 * version and cannot tell viewers apart, so a snapshot-link or test viewer
 * must not make a version that declares hosts reach them with secrets filled in.
 */
const refusedForHosts = async (
  claims: ViewTokenClaims,
  wiring: AppGatewayWiring
): Promise<boolean> => {
  let snapshot = false;
  if (claims.viewer === "link" && claims.shareId) {
    const state = await wiring.ports.shares.state(
      claims.shareId,
      claims.artifactId
    );
    snapshot = state.ok && state.dataMode === "snapshot";
  }
  if (!(snapshot || claims.viewer === "test")) {
    return false;
  }
  return await wiring.declaresHosts(claims.versionId);
};

/**
 * Whether a link holder is inside the flood guard. Members are the workspace's
 * own people and are not counted. The exact limits on tool calls (60 a minute
 * per link, 10 per visitor) live in the service; this one guards the app's
 * server part, and the approved hosts it can reach, from a runaway client.
 */
const withinLimit = async (
  c: Context<AppEnv>,
  claims: ViewTokenClaims,
  deps: AppGatewayMountDeps
): Promise<boolean> => {
  const limiter = deps.limiter?.(c.env);
  if (!(limiter && claims.viewer === "link" && claims.shareId)) {
    return true;
  }
  const ip = c.req.header("CF-Connecting-IP");
  const prefix = ip ? truncateIp(ip) : null;
  const keys = [
    `api:link:${claims.shareId}`,
    ...(prefix ? [`api:ip:${prefix}`] : []),
  ];
  const results = await Promise.all(keys.map((key) => limiter.limit({ key })));
  return results.every((result) => result.success);
};

export const mountAppGatewayRoutes = (
  app: Hono<AppEnv>,
  deps: AppGatewayMountDeps
): void => {
  const handler = async (c: Context<AppEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    const csp: ContentCspInput = { appOrigin: url.origin, contentBase: null };
    const finish = (response: Response) => {
      const wrapped = withContentHeaders(response, csp);
      // Gateway answers are no-store already; so are these.
      wrapped.headers.set("Cache-Control", "private, no-store");
      return wrapped;
    };
    try {
      const parsed = parseArtifactContentPath(url.pathname);
      if (!parsed) {
        return finish(text(NOT_FOUND, "Not found."));
      }
      csp.contentBase = `${url.origin}${artifactContentPath({
        artifactId: parsed.artifactId,
        token: parsed.token,
      })}`;
      const claims = await verifyViewToken(
        parsed.token,
        deps.viewKey(c.env),
        deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000)
      );
      if (!claims || claims.artifactId !== parsed.artifactId) {
        return finish(text(UNAUTHORIZED, "Unauthorized."));
      }
      if (c.req.header("Service-Worker") === "script") {
        return finish(text(FORBIDDEN, "Forbidden."));
      }
      if (!(await withinLimit(c, claims, deps))) {
        return finish(
          new Response("Too many requests.", {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Retry-After": "60",
            },
            status: 429,
          })
        );
      }
      const wiring = deps.wiring(c);
      if (await refusedForHosts(claims, wiring)) {
        return finish(
          text(FORBIDDEN, "This link cannot use the app's server.")
        );
      }
      return await handleAppRequest(c.req.raw, claims, {
        applyContentHeaders: finish,
        defer: wiring.defer,
        ports: wiring.ports,
        recordError: wiring.recordError,
        requestMeta: wiring.requestMeta,
        runtime: wiring.runtime,
        wallMs: wiring.wallMs,
      });
    } catch {
      return finish(text(502, "The app's server could not answer."));
    }
  };
  app.all("/a/:id/c/:token/api", handler);
  app.all("/a/:id/c/:token/api/*", handler);
};
