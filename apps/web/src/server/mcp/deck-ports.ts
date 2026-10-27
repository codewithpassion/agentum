import { ToolError } from "@repo/mcp/result";
import type { DeckCreationPort, DeckPort } from "@repo/mcp/tools/deck";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose";
import { guarded } from "./guarded";

export const createDeckPorts = ({
  principal,
  services,
  publicBaseUrl,
  toolCallId,
}: {
  principal: Principal;
  services: Services;
  publicBaseUrl?: string;
  toolCallId?: string;
}): { deck: DeckPort; deckCreation: DeckCreationPort } => {
  const room = async (artifactId: string) => {
    if (!(services.liveRoom && services.liveArtifacts)) {
      throw new ToolError("validation", "Live decks unavailable");
    }
    const stub = await services.liveRoom(principal, artifactId);
    const identity = await services.liveArtifacts.roomIdentity(
      principal,
      artifactId
    );
    return { identity, stub };
  };
  return {
    deck: {
      read: (input) =>
        guarded(async () => {
          const { stub, identity } = await room(input.artifactId);
          return stub.deckRead(input, identity);
        }),
      write: (input) =>
        guarded(async () => {
          if (principal.kind !== "run") {
            throw new ToolError("forbidden", "Running agent required");
          }
          const { stub, identity } = await room(input.artifactId);
          const callId = toolCallId ?? crypto.randomUUID();
          const digest = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`${principal.runId}:${callId}`)
            )
          );
          const changeId = [...digest]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          await stub.setAgentPresence({
            color: identity.color,
            id: identity.participantId,
            kind: "agent",
            name: identity.name,
            status: "Editing deck",
          });
          try {
            const result = await stub.deckWrite(input, {
              changeId,
              mode: "direct",
              participantId: identity.participantId,
              runId: principal.runId,
              toolCallId: callId,
            });
            await stub.checkpoint();
            return result;
          } finally {
            await stub.setAgentPresence(null);
          }
        }),
    },
    deckCreation: {
      create: (input) =>
        guarded(async () => {
          if (!services.liveArtifacts) {
            throw new ToolError("validation", "Live decks unavailable");
          }
          const result = await services.liveArtifacts.createDeck(
            principal,
            input
          );
          return {
            artifactId: result.artifactId,
            url: `${publicBaseUrl ?? ""}/a/${result.artifactId}`,
          };
        }),
    },
  };
};
