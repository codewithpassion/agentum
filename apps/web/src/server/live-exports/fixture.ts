/** biome-ignore-all lint/suspicious/useAwait: Async boundary fixtures retain production port signatures. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Sequential lifecycle cases mutate isolated authority and resource fixtures. */

import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { principals } from "../../../../../packages/services/src/artifacts/test-harness";
import { exportHarness } from "../../../../../packages/services/src/live-exports/fixture";
import type { Composed } from "../compose";
import type { AppEnv } from "../routes/groups";
import { liveExportRoutes } from "./routes";

export async function exportRouteHarness(
  kind: "document" | "deck" = "document"
) {
  const h = await exportHarness(kind);
  let principal: Principal | null = principals.owner;
  let allowed = true;
  const composed = {
    services: { liveExports: h.service },
  } as unknown as Composed;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/",
    liveExportRoutes(async () => principal)
  );
  const env = {
    EXPORT_LIMIT: { limit: async () => ({ success: allowed }) },
  } as unknown as Env;
  const path = `/api/live-artifacts/${h.artifactId}/export/`;
  return {
    ...h,
    app,
    composed,
    env,
    path,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setPrincipal: (next: Principal | null) => {
      principal = next;
    },
  };
}
