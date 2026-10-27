import { parseEmbedSource } from "@repo/protocol/deck";
import { z } from "zod";
import { liveApi } from "../live-artifacts/live-api";

const pathSchema = z.string().regex(/^\/files\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/);
export function deckServices(artifactId: string) {
  const requests = new Map<number, string>();
  return {
    ensureCell: (slideId: string, elementId: string, key: string) =>
      liveApi.ensureDeckCell.mutate({ artifactId, elementId, key, slideId }),
    history: () => liveApi.history.query({ artifactId }),
    open: () => liveApi.open.query({ artifactId }),
    async policy() {
      const result = await liveApi.ownBlobUrls.query({ artifactId });
      let cursor: string | undefined;
      const discovered: string[] = [];
      do {
        // biome-ignore lint/performance/noAwaitInLoops: sequential keyset pagination.
        const page = await liveApi.embedSources.query({ artifactId, cursor });
        discovered.push(...page.sources);
        cursor = page.next;
      } while (cursor);
      return new Set(
        z
          .array(
            z
              .string()
              .refine(
                (path) =>
                  pathSchema.safeParse(path).success ||
                  parseEmbedSource(path) !== null
              )
          )
          .parse([...result.urls, ...discovered])
      );
    },
    resolveEmbed: (source: string) =>
      liveApi.resolveEmbed.query({ artifactId, source }),
    async restore(version: number) {
      const requestId = requests.get(version) ?? crypto.randomUUID();
      requests.set(version, requestId);
      await liveApi.restore.mutate({ artifactId, requestId, version });
      requests.delete(version);
    },
    async upload(file: File) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(
        `/api/live-artifacts/${encodeURIComponent(artifactId)}/images`,
        {
          body: form,
          credentials: "same-origin",
          method: "POST",
        }
      );
      if (!response.ok) {
        throw new Error(`Image upload failed (${response.status})`);
      }
      const { url } = z
        .object({ url: pathSchema })
        .parse(await response.json());
      return { path: url };
    },
  };
}
