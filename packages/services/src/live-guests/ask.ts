/** Cookie-authenticated asks. All identity, room and session fields are trusted. */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { artifacts } from "@repo/db/schema/artifacts";
import { sessions } from "@repo/db/schema/sessions";
import { guestAskSchema } from "@repo/protocol/guest";
import { and, eq } from "drizzle-orm";
import { guestUnavailable } from "../runs/guest-scope.ts";
import type { StartRunOptions } from "../runs/types.ts";
import type { RunsService } from "../runs.ts";
import { buildSpeakerEnvelope, type SpeakerRoom } from "../speaker-envelope.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import type { GuestCredential } from "./artifacts.ts";
import type { LiveGuestsService } from "./service.ts";

export const createGuestAskSelection =
  (deps: { db: Database; guests: Pick<LiveGuestsService, "resolve"> }) =>
  async (credential: GuestCredential, input: { agentId?: string }) => {
    const grant = await deps.guests.resolve(credential);
    if (!grant || grant.role === "viewer") {
      throw guestUnavailable();
    }
    const [artifact] = await deps.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, grant.artifactId),
          eq(artifacts.workspaceId, grant.workspaceId)
        )
      )
      .limit(1);
    const [session] = await deps.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, grant.workspaceId),
          eq(sessions.origin, "artifact"),
          eq(sessions.externalKey, grant.artifactId),
          eq(sessions.private, false)
        )
      )
      .limit(1);
    const selected =
      session?.agentId ?? artifact?.handedToAgentId ?? artifact?.agentId;
    // A guest cannot pick an unrelated workspace agent, even by guessing its ID.
    if (
      !artifact ||
      artifact.deletedAt ||
      !selected ||
      (input.agentId && input.agentId !== selected)
    ) {
      throw guestUnavailable();
    }
    const [agent] = await deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.id, selected),
          eq(agents.workspaceId, grant.workspaceId),
          eq(agents.status, "active")
        )
      )
      .limit(1);
    if (!agent) {
      throw guestUnavailable();
    }
    return { agent, artifact, grant, session };
  };

export const createGuestAsk =
  (deps: {
    db: Database;
    guests: Pick<LiveGuestsService, "resolve" | "details" | "startRun">;
    runs: Pick<RunsService, "offerQueuedRun">;
    /** An authenticated room lookup, never submitted awareness/roster. */
    presence: (
      credential: GuestCredential
    ) => Promise<Pick<SpeakerRoom, "present" | "where">>;
  }) =>
  async (
    credential: GuestCredential,
    raw: unknown,
    comment?: { threadId: string; alongside: StartRunOptions["alongside"] }
  ) => {
    const input = guestAskSchema.parse(raw);
    const { agent, artifact, grant, session } = await createGuestAskSelection(
      deps
    )(credential, input);
    const details = await deps.guests.details(credential);
    const room = await deps.presence(credential);
    const current = await deps.guests.resolve(credential);
    if (!current || current.role === "viewer") {
      throw guestUnavailable();
    }
    const result = await deps.guests.startRun({
      ...credential,
      alongside: comment?.alongside,
      run: {
        agentId: agent.id,
        input: {
          text: buildSpeakerEnvelope(
            {
              actor: { id: current.guestId, kind: "guest" },
              name: details.guestName,
              role: current.role,
            },
            {
              ...room,
              artifact: {
                id: artifact.id,
                kind: artifact.kind as "document" | "deck",
                title: artifact.title,
              },
              where: comment
                ? { ...room.where, threadId: comment.threadId }
                : room.where,
            },
            comment ? "comment" : "artifact_thread",
            input.text
          ),
        },
        requestId: input.requestId,
        session: {
          externalKey: grant.artifactId,
          origin: "artifact",
          private: false,
        },
      },
      ...(session ? { sessionId: session.id } : {}),
    });
    return {
      ...result,
      offer: () => deps.runs.offerQueuedRun(SYSTEM_PRINCIPAL, result.runId),
    };
  };
