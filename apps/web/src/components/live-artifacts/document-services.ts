import { relativePositionSchema } from "@repo/protocol/live";
import { z } from "zod";
import { getTrpc } from "#/integrations/trpc/client";
import type { HistoryPort } from "./editor-ports";
import { liveApi } from "./live-api";
import type { RoomPolicy } from "./room-provider";

export const roomPolicySchema = z.object({
  agentChanges: z
    .array(
      z.object({
        end: relativePositionSchema,
        id: z.string(),
        name: z.string(),
        start: relativePositionSchema,
        text: z.string(),
      })
    )
    .optional()
    .default([]),
  ownBlobUrls: z.array(
    z.string().regex(/^\/files\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/)
  ),
});

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
  const restoreRequests = new Map<string, string>();
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
        const requestId = restoreRequests.get(id) ?? crypto.randomUUID();
        restoreRequests.set(id, requestId);
        await liveApi.restore.mutate({ artifactId, requestId, version });
        restoreRequests.delete(id);
      },
    } satisfies HistoryPort,
    async policy(): Promise<RoomPolicy> {
      const result = roomPolicySchema.parse(await request(`${base}/policy`));
      return {
        agentChanges: result.agentChanges,
        ownBlobUrls: new Set(result.ownBlobUrls),
      };
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
