import { ExportError } from "@repo/live-export";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { authenticateRoomRequest } from "../live-artifacts/auth";
import type { AppEnv } from "../routes/groups";

export const liveExportRoutes = (authenticate = authenticateRoomRequest) =>
  new Hono<AppEnv>()
    .use("/api/live-artifacts/:artifactId/export/:format", csrf())
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One HTTP boundary handles authentication, admission and structured refusal mapping.
    .post("/api/live-artifacts/:artifactId/export/:format", async (c) => {
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      try {
        const composed = c.get("composed");
        const principal = await authenticate(c.env, composed, c.req.raw);
        if (principal?.kind !== "user") {
          return c.json({ error: "Member authentication required" }, 401);
        }
        const format = c.req.param("format");
        if (format !== "docx" && format !== "pptx" && format !== "pdf") {
          return c.json({ error: "Unsupported export format" }, 400);
        }
        const allowance = await c.env.EXPORT_LIMIT.limit({
          key: `${principal.workspaceId}:${principal.userId}`,
        });
        if (!allowance.success) {
          return c.json(
            { error: "Too many exports. Try again in a minute." },
            429
          );
        }
        const service = composed.services.liveExports;
        if (!service) {
          return c.json({ error: "Export unavailable" }, 503);
        }
        const result = await service.download(
          principal,
          { artifactId: c.req.param("artifactId"), format },
          async () => {
            const current = await authenticate(c.env, composed, c.req.raw);
            if (
              current?.kind !== "user" ||
              current.userId !== principal.userId ||
              current.workspaceId !== principal.workspaceId ||
              current.isAdmin !== principal.isAdmin
            ) {
              throw new ExportError("export_access_ended");
            }
          },
          c.req.raw.signal
        );
        return new Response(new Uint8Array(result.bytes), {
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Disposition": `attachment; filename="${result.filename}"`,
            "Content-Type": result.mime,
            "X-Content-Type-Options": "nosniff",
            "X-Export-Revision": String(result.revision),
            "X-Export-Warnings": result.warnings,
          },
        });
      } catch (error) {
        if (isForbiddenError(error)) {
          return c.json({ error: "Forbidden" }, 403);
        }
        if (isServiceError(error)) {
          return c.json(
            { error: error.message },
            error.code === "not_found" ? 404 : 400
          );
        }
        if (error instanceof ExportError) {
          const statuses = {
            export_access_ended: 403,
            export_cancelled: 408,
            export_timeout: 504,
            export_unavailable: 503,
          } as const;
          const status = statuses[error.code as keyof typeof statuses] ?? 422;
          return c.json({ error: error.code }, status);
        }
        return c.json(
          { error: "Export failed. Please retry or choose another format." },
          500
        );
      }
    });
