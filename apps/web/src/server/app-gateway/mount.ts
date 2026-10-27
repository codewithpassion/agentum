/**
 * The route for `/a/<uuid>/c/<token>/api/*` (PRD section 5). It verifies the
 * view token, checks that the path names the token's artifact, applies the
 * rule for snapshot-link and test viewers (R2.6), then hands the request to
 * the gateway. Mounted in `server.ts` before the content routes, which would
 * answer 405 to a POST. Every answer leaves through `withContentHeaders`.
 */
import {
  artifactContentPath,
  parseArtifactContentPath,
  type ViewTokenClaims,
} from "@repo/protocol/artifacts";
import { verifyViewToken } from "@repo/services/artifacts/view-token";
import type { Context, Hono } from "hono";
import {
  type ContentCspInput,
  withContentHeaders,
} from "../artifact-content/headers.ts";
import type { AppEnv } from "../routes/groups.ts";
import type { AppGatewayDeps } from "./gateway-core.ts";
import { handleAppRequest } from "./gateway-core.ts";

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

/** What one request needs on top of the token: built from the bindings and the execution context. */
export interface AppGatewayWiring
  extends Omit<AppGatewayDeps, "applyContentHeaders"> {
  /** Whether the version asked for any host, approved or not. */
  declaresHosts: (versionId: string) => Promise<boolean>;
}

export interface AppGatewayMountDeps {
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

export const mountAppGatewayRoutes = (
  app: Hono<AppEnv>,
  deps: AppGatewayMountDeps
): void => {
  const handler = async (c: Context<AppEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    const csp: ContentCspInput = { appOrigin: url.origin, contentBase: null };
    const finish = (response: Response) => withContentHeaders(response, csp);
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
      const wiring = deps.wiring(c);
      if (await refusedForHosts(claims, wiring)) {
        return finish(
          text(FORBIDDEN, "This link cannot use the app's server.")
        );
      }
      return await handleAppRequest(c.req.raw, claims, {
        applyContentHeaders: finish,
        ports: wiring.ports,
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
