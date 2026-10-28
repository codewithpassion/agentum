/** The only production guest MCP registry. Never constructs general MCP ports. */
import { createGuestMcpServer } from "@repo/mcp/guest";
import { createGuestRunAccess } from "@repo/services/live-guests/run-access";
import { createScopedGuestComments } from "@repo/services/live-guests/scoped-comments";
import type { Principal } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import { createDeckPorts } from "./deck-ports";
import { guarded } from "./guarded";
import { createLivePorts } from "./live-ports";

export const guestMcpServer = async (input: {
  composed: Composed;
  principal: Extract<Principal, { kind: "run" }>;
  guestsOff: () => boolean;
  toolCallId?: string;
}) => {
  const { composed, principal } = input;
  const artifactId = principal.scopeArtifactId;
  if (!artifactId) {
    throw new Error("Scoped guest run required");
  }
  const authorize = createGuestRunAccess({
    ...composed,
    guestsOff: input.guestsOff,
    runs: composed.services.runs,
  });
  const current = await authorize(principal, artifactId);
  const identity = await composed.services.liveArtifacts?.roomIdentity(
    principal,
    artifactId
  );
  if (!identity?.forceSuggestions) {
    throw new Error("Suggestion-only identity required");
  }
  const originalLive = createLivePorts({
    principal,
    services: composed.services,
    toolCallId: input.toolCallId,
  });
  const comments = createScopedGuestComments({
    ...composed,
    events: composed.services.events,
    guestsOff: input.guestsOff,
    runs: composed.services.runs,
  });
  const live = {
    ...originalLive,
    comment: (value: Parameters<typeof originalLive.comment>[0]) =>
      guarded(async () => {
        if (!input.toolCallId) {
          throw new Error("Stable comment call id required");
        }
        await authorize(principal, value.artifactId);
        const stub = value.quote
          ? await composed.services.liveRoom?.(principal, value.artifactId)
          : undefined;
        const anchor = value.quote
          ? await stub?.documentAnchor({
              blockId: value.blockId,
              nth: value.nth,
              quote: value.quote,
            })
          : undefined;
        return comments.apply(
          principal,
          value,
          input.toolCallId,
          anchor,
          value.quote
        );
      }),
  };
  const { deck } = createDeckPorts({
    principal,
    services: composed.services,
    toolCallId: input.toolCallId,
  });
  return createGuestMcpServer({
    authorize: async (id, write) => ({
      ...(await authorize(principal, id, write)),
      artifactId: id,
    }),
    comments: live.comment,
    deck,
    live,
    scope: { ...current, artifactId },
    suggestions: { deck: deck.write, document: live.edit },
    supported: [
      "document_read",
      "document_comments",
      "document_comment",
      "deck_comment",
      "deck_comments",
      "document_edit",
      "deck_read",
      "deck_write",
    ],
  });
};
