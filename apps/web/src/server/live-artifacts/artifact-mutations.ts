import type { ArtifactsService } from "@repo/services/artifacts/service";
import { ServiceError } from "@repo/services/errors";
import type { LiveArtifactsWithAsk } from "@repo/services/live-artifacts/factory";

/** Existing artifact browser/MCP surfaces must use the live mutation path too,
 * including its room fence, provenance and durable invalidation outbox. */
export const liveArtifactMutations = (
  artifacts: ArtifactsService,
  live: LiveArtifactsWithAsk | undefined
): ArtifactsService => {
  if (!live) {
    return artifacts;
  }
  return {
    ...artifacts,
    async remove(principal, artifactId) {
      const row = await artifacts.get(principal, artifactId);
      if (row.kind === "document" || row.kind === "deck") {
        return live.remove(principal, { artifactId });
      }
      return artifacts.remove(principal, artifactId);
    },
    async restore(principal, artifactId, version) {
      const row = await artifacts.get(principal, artifactId);
      if (row.kind === "document" || row.kind === "deck") {
        return live.restore(principal, { artifactId, version });
      }
      return artifacts.restore(principal, artifactId, version);
    },
    async setAudience(principal, artifactId, audience) {
      const row = await artifacts.get(principal, artifactId);
      if (row.kind === "document" || row.kind === "deck") {
        return live.setAudience(principal, { artifactId, audience });
      }
      return artifacts.setAudience(principal, artifactId, audience);
    },
    async update(principal, input) {
      const row = await artifacts.get(principal, input.artifactId);
      if (row.kind === "document" || row.kind === "deck") {
        throw new ServiceError(
          "invalid",
          row.kind === "deck"
            ? "Use deck_write to edit live decks"
            : "Use document_edit to edit live documents"
        );
      }
      return artifacts.update(principal, input);
    },
  };
};
