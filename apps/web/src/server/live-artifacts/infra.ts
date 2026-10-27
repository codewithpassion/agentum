import { createClerkClient } from "@clerk/backend";
import { artifactContentPath } from "@repo/protocol/artifacts";
import { signViewToken } from "@repo/services/artifacts/view-token";
import { ForbiddenError } from "@repo/services/authz";
import { ServiceError } from "@repo/services/errors";
import type { LiveAskDeps } from "@repo/services/live-artifacts/ask";
import type { LiveMentionPort } from "@repo/services/live-artifacts/mentions";
import type { LiveArtifactsDeps } from "@repo/services/live-artifacts/service";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import { freshMember } from "./auth";
import { documentContent } from "./content";
import { deckContent } from "./deck-content";
import { productionMentionInfra } from "./mention-infra";
import { roomStub } from "./namespace";
import { publicImageFetch } from "./public-image-fetch";
import { requiredLive } from "./required";

export interface LiveInfra
  extends Pick<
      LiveArtifactsDeps,
      | "anchors"
      | "changes"
      | "content"
      | "externalImageFetch"
      | "identity"
      | "rooms"
      | "ticketKey"
    >,
    Pick<LiveAskDeps, "presence" | "resolveMember"> {
  guestPresence?: (scope: {
    artifactId: string;
    workspaceId: string;
  }) => Promise<boolean>;
  mentions?: LiveMentionPort;
  roomFor: (
    principal: import("@repo/services/workspaces").Principal,
    artifactId: string
  ) => ReturnType<typeof roomStub>;
  wake: () => Promise<void>;
}
export const productionLiveInfra = (
  env: Env,
  composed: () => Composed
): LiveInfra => {
  const stub = (scope: Parameters<typeof roomStub>[1]) =>
    roomStub(env.ARTIFACT_ROOM, scope);
  return {
    anchors: {
      guardAgentSnapshot: async (scope, input) =>
        (await stub(scope)).guardAgentSnapshot(input),
      resolve: async (scope, anchor) =>
        (await stub(scope)).resolveAnchor(anchor),
    },
    changes: {
      revert: async (scope, input) => {
        const room = await stub(scope);
        if (!input.principal) {
          throw new Error("Authenticated actor required");
        }
        await room.registerActor(input.principal);
        return room.revert(input.changeId, input.byParticipant);
      },
    },
    content: {
      embedUrl: async (source, scope, userId) => {
        if (!env.ARTIFACT_VIEW_KEY) {
          throw new Error("Artifact viewing is unavailable");
        }
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const token = await signViewToken(
          {
            artifactId: source.artifactId,
            embedFile: { path: source.path, sha256: source.sha256 },
            expiresAt,
            userId,
            versionId: source.versionId,
            viewer: "member",
            workspaceId: scope.workspaceId,
          },
          env.ARTIFACT_VIEW_KEY
        );
        return {
          contentUrl: artifactContentPath({
            artifactId: source.artifactId,
            path: source.path,
            token,
          }),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        };
      },
      ...documentContent(async (scope) =>
        scope
          ? new Set(
              (
                await requiredLive(composed().services).roomPolicy(
                  SYSTEM_PRINCIPAL,
                  scope
                )
              ).ownBlobUrls
            )
          : new Set()
      ),
      ...deckContent(async (scope) =>
        scope
          ? new Set(
              (
                await requiredLive(composed().services).roomPolicy(
                  SYSTEM_PRINCIPAL,
                  scope
                )
              ).ownBlobUrls
            )
          : new Set()
      ),
    },
    externalImageFetch: publicImageFetch(env.LOADER),
    guestPresence: async (scope) =>
      (await (await stub(scope)).askPresence("")).present.some(
        (entry) => entry.kind === "guest"
      ),
    identity: async (principal) => {
      if (principal.kind === "run" && principal.scopeArtifactId) {
        const execution = await composed().services.runs.guestExecution(
          SYSTEM_PRINCIPAL,
          principal.runId
        );
        return { color: "#8b5cf6", name: execution.name };
      }
      if (principal.kind === "run") {
        const agent = await composed().services.agents.get(
          principal,
          principal.agentId
        );
        return { color: "#8b5cf6", name: agent.name };
      }
      // The shared people service resolves trusted names; ids remain a safe fallback.
      const user = await createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
      }).users.getUser(principal.userId);
      return {
        color: "#3b82f6",
        name:
          [user.firstName, user.lastName].filter(Boolean).join(" ") ||
          user.username ||
          "Member",
      };
    },
    mentions: productionMentionInfra(env, composed),
    presence: async (scope, member) =>
      (await stub(scope)).askPresence(`u:${member.userId}`),
    resolveMember: (scope, userId) =>
      freshMember(env, composed(), scope.workspaceId, userId),
    roomFor: async (principal, artifactId) => {
      if (principal.kind === "system") {
        throw new Error("Authenticated member required");
      }
      await requiredLive(composed().services).roomIdentity(
        principal,
        artifactId
      );
      const room = await stub({
        artifactId,
        workspaceId: principal.workspaceId,
      });
      await room.registerActor(principal);
      return room;
    },
    rooms: {
      agentChanges: async (scope) => (await stub(scope)).agentChanges(),
      checkpointCanonical: async (scope, input) => {
        const room = await stub(scope);
        await room.registerActor(input.principal);
        return room.checkpointCanonical(input);
      },
      checkpointIfDue: async (scope) => (await stub(scope)).checkpointIfDue(),
      ensureDeckCell: async (scope, input) => {
        const room = await stub(scope);
        await room.registerActor(input.principal);
        const identity = await requiredLive(composed().services).roomIdentity(
          input.principal,
          scope.artifactId
        );
        const outcome = await room.ensureDeckCellOutcome(
          {
            elementId: input.elementId,
            key: input.key,
            slideId: input.slideId,
          },
          identity
        );
        if (!outcome.ok) {
          if (outcome.code === "forbidden") {
            throw new ForbiddenError("liveArtifacts.ensureDeckCell");
          }
          throw new ServiceError(
            outcome.code === "not_found" ? "not_found" : "invalid",
            outcome.message
          );
        }
        return outcome.result;
      },
      refresh: async (scope, participantId, id) =>
        (await stub(scope)).completeInvalidation(participantId, id),
      registerImage: async (scope, fileId) =>
        (await stub(scope)).registerImage(fileId),
      restore: async (scope, input) => {
        const room = await stub(scope);
        if (!input.principal) {
          throw new Error("Authenticated restore actor required");
        }
        await room.registerActor(input.principal);
        return room.restoreAuthorized(input);
      },
      retainedDeckEmbeds: async (scope) =>
        (await stub(scope)).retainedDeckEmbeds(),
      saveRestored: async (scope) => (await stub(scope)).checkpoint(),
      snapshot: async (scope) => (await stub(scope)).authoritativeSnapshot(),
      suggestions: async (scope, input) => {
        const room = await stub(scope);
        await room.registerActor(input.principal);
        const identity = await requiredLive(composed().services).roomIdentity(
          input.principal,
          scope.artifactId
        );
        if (input.action === "mode") {
          await room.setSuggestionMode(input.enabled === true, identity);
        }
        if (input.action === "decide") {
          if (!(input.suggestionId && input.decision)) {
            throw new Error("Decision required");
          }
          const result = await room.decideSuggestion(
            { decision: input.decision, suggestionId: input.suggestionId },
            identity
          );
          if (result.status === "accepted") {
            await room.checkpoint();
          }
        }
        return room.listSuggestions(identity);
      },
      suspend: async (scope, id) => (await stub(scope)).suspend(id),
      url: (scope) => `/api/rooms/${scope.artifactId}`,
    },
    ticketKey: env.ARTIFACT_VIEW_KEY
      ? `artifact-room:${env.ARTIFACT_VIEW_KEY}`
      : "",
    wake: () => env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start(),
  };
};
