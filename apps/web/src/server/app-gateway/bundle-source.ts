import { artifactManifestSchema } from "@repo/protocol/artifacts";
import { blobKey, manifestKey } from "../artifact-content/keys.ts";
import type { ContentBucket } from "../artifact-content/routes.ts";
import type { AppBundle } from "./ports.ts";

const SERVER_DIR = "server/";
const decoder = new TextDecoder();

export const bundleOf =
  (
    services: {
      artifactApp: {
        versionWorkspaceId: (
          artifactId: string,
          versionId: string
        ) => Promise<string | null>;
        declaresHosts: (versionId: string) => Promise<boolean>;
      };
    },
    bucket: ContentBucket
  ) =>
  async (artifactId: string, versionId: string): Promise<AppBundle | null> => {
    const workspaceId = await services.artifactApp.versionWorkspaceId(
      artifactId,
      versionId
    );
    if (!workspaceId) {
      return null;
    }
    const manifestObject = await bucket.get(
      manifestKey(workspaceId, versionId)
    );
    if (!manifestObject) {
      return null;
    }
    const manifest = artifactManifestSchema.parse(
      JSON.parse(decoder.decode(await manifestObject.arrayBuffer()))
    );
    const files = await Promise.all(
      Object.entries(manifest.files)
        .filter(([path]) => path.startsWith(SERVER_DIR))
        .map(async ([path, file]) => {
          const blob = await bucket.get(blobKey(workspaceId, file.sha256));
          if (!blob) {
            throw new Error(`The blob of ${path} is missing.`);
          }
          return { bytes: new Uint8Array(await blob.arrayBuffer()), path };
        })
    );
    return {
      declaresHosts: await services.artifactApp.declaresHosts(versionId),
      files,
    };
  };
