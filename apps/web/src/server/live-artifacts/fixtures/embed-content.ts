/** biome-ignore-all lint/suspicious/useAwait: Implements the asynchronous bucket test port. */
/** Controlled content only; mounted solely by the actual-room test entry. */
import { artifactContentPath } from "@repo/protocol/artifacts";
import { signViewToken } from "@repo/services/artifacts/view-token";
import { Hono } from "hono";
import { mountArtifactContentRoutes } from "../../artifact-content/routes";
import type { AppEnv } from "../../routes/groups";

export const embedSource = `artifact:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:${"a".repeat(64)}:chart.html`;
const key = "controlled-content-fixture";
const app = new Hono<AppEnv>();
const html = `<!doctype html><html><body><h1>Controlled sandbox chart</h1><button onclick="document.querySelector('output').textContent='Clicked safely'">Explore chart</button><output>Ready</output><script>try { parent.document.body.dataset.escaped = 'yes' } catch { document.body.dataset.isolated = 'yes' }</script></body></html>`;
mountArtifactContentRoutes(app, {
  bucket: () => ({
    get: async (path) => {
      const body = path.endsWith(".json")
        ? JSON.stringify({
            entry: "chart.html",
            files: {
              "chart.html": {
                contentType: "text/html",
                sha256: "a".repeat(64),
                size: html.length,
              },
            },
          })
        : html;
      return {
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
        body: new Response(body).body as ReadableStream,
        size: body.length,
      };
    },
  }),
  viewKey: () => key,
  workspaceId: (claims) => claims.workspaceId,
});
app.post("/embed-url", async (c) => {
  const { source } = await c.req.json<{ source: string }>();
  if (source !== embedSource) {
    return c.json({ error: "Refused" }, 403);
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const token = await signViewToken(
    {
      artifactId: "11111111-1111-4111-8111-111111111111",
      embedFile: { path: "chart.html", sha256: "a".repeat(64) },
      expiresAt,
      userId: "member",
      versionId: "22222222-2222-4222-8222-222222222222",
      viewer: "member",
      workspaceId: "fixture",
    },
    key
  );
  return c.json({
    contentUrl: artifactContentPath({
      artifactId: "11111111-1111-4111-8111-111111111111",
      path: "chart.html",
      token,
    }),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
});
export const embedContentFetch = (request: Request) => app.fetch(request);
