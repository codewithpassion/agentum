// Artifact HTTP routes outside the content host: the public link open
// `POST /api/share/:token/open`, and the cookie-session `GET
// /api/artifacts/:id/thumbnail` and `GET /api/artifacts/:id/download`. Content
// itself is served by `artifact-content/routes.ts`. Mounted once in server.ts.

import { truncateIp } from "@repo/services/artifacts/view-privacy";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fileResponseHeaders } from "./files.ts";
import type { AppEnv } from "./groups.ts";

const OK = 200;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const TOO_MANY = 429;
const BAD_REQUEST = 400;
const RETRY_AFTER_SECONDS = "60";
/** The one body every refused link open gets, so a caller learns nothing about why. */
const LINK_UNAVAILABLE = "This link is not available.";
const VERSION_PARAM = /^[1-9][0-9]{0,8}$/;

export interface ArtifactRoutesDeps {
  /** The Clerk session of the request: its user, active org and role, or null. */
  session: (c: Context<AppEnv>) => {
    orgId?: string | null;
    orgRole?: string | null;
    userId: string | null;
  } | null;
}

const json = (
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: string
) => c.json({ error }, status);

const sha256Hex = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Whether this open is inside the limits: one count per token (hashed, so the
 * secret never reaches the limiter) and one per IP prefix. A binding that is
 * missing (some dev setups) does not limit.
 */
const withinLimits = async (
  c: Context<AppEnv>,
  token: string,
  ip: string | null
): Promise<boolean> => {
  const limiter = c.env.SHARE_OPEN_LIMIT as Env["SHARE_OPEN_LIMIT"] | undefined;
  if (!limiter) {
    return true;
  }
  const prefix = ip ? truncateIp(ip) : null;
  const keys = [
    `token:${(await sha256Hex(token)).slice(0, 32)}`,
    ...(prefix ? [`ip:${prefix}`] : []),
  ];
  const results = await Promise.all(keys.map((key) => limiter.limit({ key })));
  return results.every((result) => result.success);
};

const sessionPrincipal = (
  c: Context<AppEnv>,
  deps: ArtifactRoutesDeps
): Promise<Principal | null> => {
  const session = deps.session(c);
  if (!session?.userId) {
    return Promise.resolve(null);
  }
  return c.get("composed").services.workspaces.sessionPrincipal({
    orgId: session.orgId,
    orgRole: session.orgRole,
    userId: session.userId,
  });
};

/** The `version` query parameter: absent is the current version, junk is a 400. */
const versionOf = (c: Context<AppEnv>): number | undefined | "bad" => {
  const raw = c.req.query("version");
  if (raw === undefined) {
    return;
  }
  return VERSION_PARAM.test(raw) ? Number(raw) : "bad";
};

const refusal = (c: Context<AppEnv>, error: unknown) => {
  // Hidden, missing and forbidden read the same.
  if (isForbiddenError(error) || isServiceError(error)) {
    return json(c, NOT_FOUND, "Not found.");
  }
  throw error;
};

export const artifactRoutes = (deps: ArtifactRoutesDeps): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  // Public: no cookie is read, so there is nothing for a cross-site page to ride on.
  routes.post("/api/share/:token/open", async (c) => {
    const token = c.req.param("token");
    const ip = c.req.header("CF-Connecting-IP") ?? null;
    if (!(await withinLimits(c, token, ip))) {
      return c.json({ error: "Too many requests." }, TOO_MANY, {
        "Cache-Control": "no-store",
        "Retry-After": RETRY_AFTER_SECONDS,
      });
    }
    const result = await c
      .get("composed")
      .services.artifactShares.openLink(token, {
        cf: (c.req.raw as { cf?: Record<string, unknown> }).cf ?? null,
        ip,
        referrer: c.req.header("Referer") ?? null,
        userAgent: c.req.header("User-Agent") ?? null,
      });
    if (!result.ok) {
      return c.json({ error: LINK_UNAVAILABLE }, NOT_FOUND, {
        "Cache-Control": "no-store",
      });
    }
    return c.json(result.response, OK, { "Cache-Control": "no-store" });
  });

  routes.get("/api/artifacts/:id/thumbnail", async (c) => {
    const principal = await sessionPrincipal(c, deps);
    if (!principal) {
      return json(c, UNAUTHORIZED, "Sign in required.");
    }
    const version = versionOf(c);
    if (version === "bad") {
      return json(c, BAD_REQUEST, "Bad version.");
    }
    try {
      const png = await c
        .get("composed")
        .services.artifacts.thumbnail(principal, c.req.param("id"), version);
      return new Response(new Uint8Array(png), {
        headers: fileResponseHeaders({
          mime: "image/png",
          name: "thumbnail.png",
          size: png.byteLength,
        }),
      });
    } catch (error: unknown) {
      return refusal(c, error);
    }
  });

  routes.get("/api/artifacts/:id/download", async (c) => {
    const principal = await sessionPrincipal(c, deps);
    if (!principal) {
      return json(c, UNAUTHORIZED, "Sign in required.");
    }
    const version = versionOf(c);
    if (version === "bad") {
      return json(c, BAD_REQUEST, "Bad version.");
    }
    try {
      const { bytes, filename } = await c
        .get("composed")
        .services.artifacts.download(principal, c.req.param("id"), version);
      return new Response(new Uint8Array(bytes), {
        // A zip is not an inline type, so this is an attachment.
        headers: fileResponseHeaders({
          mime: "application/zip",
          name: filename,
          size: bytes.byteLength,
        }),
      });
    } catch (error: unknown) {
      return refusal(c, error);
    }
  });

  return routes;
};
