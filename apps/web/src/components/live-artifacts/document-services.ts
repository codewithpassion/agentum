import { z } from "zod";
import { getTrpc } from "#/integrations/trpc/client";
import type { HistoryPort } from "./editor-ports";
import { liveApi } from "./live-api";

const ownedUrl = z.string().regex(/^\/files\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/);
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Document service failed (${response.status})`);
  }
  return response.json();
}
export const documentServices = (artifactId: string) => {
  const base = `/api/live-artifacts/${encodeURIComponent(artifactId)}`;
  return {
    history: {
      async downloadMarkdown() {
        return z
          .object({ filename: z.string(), markdown: z.string() })
          .parse(await request(`${base}/markdown`));
      },
      async list() {
        const versions = await getTrpc().artifacts.versions.query({
          artifactId,
        });
        return versions.map((version) => ({
          createdAt: version.createdAt,
          id: String(version.number),
          label: `Checkpoint v${version.number}`,
        }));
      },
      async restore(id: string) {
        const version = z.coerce.number().int().positive().parse(id);
        await liveApi.restore.mutate({ artifactId, version });
      },
    } satisfies HistoryPort,
    async policy(): Promise<ReadonlySet<string>> {
      const result = z
        .object({ ownBlobUrls: z.array(ownedUrl) })
        .parse(await request(`${base}/policy`));
      return new Set(result.ownBlobUrls);
    },
    async uploadImage(file: File) {
      const form = new FormData();
      form.append("file", file);
      return z
        .object({ alt: z.string(), url: ownedUrl })
        .parse(await request(`${base}/images`, { body: form, method: "POST" }));
    },
  };
};
