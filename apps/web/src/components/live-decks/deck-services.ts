import { z } from "zod";
import { liveApi } from "../live-artifacts/live-api";

const pathSchema = z.string().regex(/^\/files\/[A-Za-z0-9][A-Za-z0-9/_\-.]*$/);
export function deckServices(artifactId: string) {
  const requests = new Map<number, string>();
  return {
    history: () => liveApi.history.query({ artifactId }),
    open: () => liveApi.open.query({ artifactId }),
    async policy() {
      const result = await liveApi.ownBlobUrls.query({ artifactId });
      return new Set(z.array(pathSchema).parse(result.urls));
    },
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
