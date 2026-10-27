/** Guest-only artifact operations. No member identity is constructed here. */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  findGuestSessionGrant,
  findGuestSessionReferenceGrant,
  guestArtifactWriteGuard,
} from "@repo/db/live-guests";
import { artifacts } from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import {
  artifactComments,
  artifactCommentThreads,
  artifactMembers,
} from "@repo/db/schema/live-artifacts";
import { sessions } from "@repo/db/schema/sessions";
import type { GuestThread } from "@repo/protocol/guest";
import type { CommentAnchor, GuestGrant } from "@repo/protocol/live";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { resolveActorDisplays } from "../actor-display.ts";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import {
  type Blobs,
  type EventRecord,
  type EventsService,
  toRecord,
} from "../events.ts";
import type { LiveAnchorPort } from "../live-artifacts/ports.ts";
import type { Clock } from "../runs/types.ts";
import { createGuestAccessReader } from "./access.ts";

export interface GuestCredential {
  artifactId: string;
  sessionToken: string;
  workspaceId: string;
}
const denied = () => new ServiceError("not_found", "Guest access unavailable");
export const createGuestArtifacts = (deps: {
  db: Database;
  atomic: Atomic;
  clock: Clock;
  guestsOff: () => boolean;
  events?: Pick<EventsService, "insertStatement">;
  payloads?: Pick<Blobs, "get">;
  anchors?: Pick<LiveAnchorPort, "resolve">;
}) => {
  const access = createGuestAccessReader(deps);
  const current = async (input: GuestCredential, write = false) => {
    const grant = await access.resolve(input);
    if (!grant || (write && grant.role === "viewer")) {
      throw denied();
    }
    return grant;
  };
  const scope = (grant: GuestGrant) =>
    and(
      eq(artifactCommentThreads.artifactId, grant.artifactId),
      eq(artifactCommentThreads.workspaceId, grant.workspaceId)
    );
  const prepareComment = async (
    input: GuestCredential,
    body: { body: string; threadId?: string; anchor?: CommentAnchor }
  ) => {
    const grant = await current(input, true);
    if (
      !body.body.trim() ||
      new TextEncoder().encode(body.body).length > 4096
    ) {
      throw denied();
    }
    if (body.threadId && body.anchor) {
      throw denied();
    }
    const resolved =
      body.anchor && deps.anchors
        ? await deps.anchors.resolve(grant, body.anchor)
        : null;
    if (body.anchor && !resolved) {
      throw denied();
    }
    const at = deps.clock.now().toISOString();
    const threadId = body.threadId ?? ulid();
    if (body.threadId) {
      const [thread] = await deps.db
        .select()
        .from(artifactCommentThreads)
        .where(and(scope(grant), eq(artifactCommentThreads.id, threadId)))
        .limit(1);
      if (!thread) {
        throw denied();
      }
    }
    return { at, grant, resolved, threadId };
  };
  return {
    async comment(
      input: GuestCredential,
      body: { body: string; threadId?: string; anchor?: CommentAnchor }
    ) {
      if ("toAgent" in body && body.toAgent) {
        throw denied();
      }
      const { grant, resolved, at, threadId } = await prepareComment(
        input,
        body
      );
      const id = ulid();
      await current(input, true);
      const tokenHash = await hashToken(input.sessionToken);
      await deps.atomic([
        guestArtifactWriteGuard(deps.db, {
          ...grant,
          at: deps.clock.now().toISOString(),
          tokenHash,
        }),
        deps.db
          .update(artifacts)
          .set({
            title: sql`CASE WHEN
          (SELECT count(*) FROM artifact_comment_threads WHERE artifact_id = ${grant.artifactId} AND workspace_id = ${grant.workspaceId}) < ${body.threadId ? 1001 : 1000}
          AND (SELECT count(*) FROM artifact_comments WHERE thread_id = ${threadId} AND workspace_id = ${grant.workspaceId}) < 100
          THEN ${artifacts.title} ELSE NULL END`,
          })
          .where(eq(artifacts.id, grant.artifactId)),
        ...(body.threadId
          ? []
          : [
              deps.db.insert(artifactCommentThreads).values({
                anchor: resolved ? JSON.stringify(resolved.anchor) : null,
                artifactId: grant.artifactId,
                id: threadId,
                quote: resolved?.quote ?? null,
                workspaceId: grant.workspaceId,
              }),
            ]),
        deps.db.insert(artifactComments).values({
          authorId: grant.guestId,
          authorKind: "guest",
          body: body.body.trim(),
          createdAt: at,
          id,
          threadId,
          workspaceId: grant.workspaceId,
        }),
        ...(deps.events
          ? [
              deps.events.insertStatement({
                actor: { id: grant.guestId, kind: "guest" },
                payload: {
                  artifactId: grant.artifactId,
                  commentId: id,
                  threadId,
                },
                type: "artifact.comment_created",
                workspaceId: grant.workspaceId,
              }),
            ]
          : []),
      ]);
      return { id, threadId };
    },
    current,
    async invitations(input: GuestCredential) {
      const grant = await current(input);
      const rows = await deps.db
        .select({
          artifactId: artifacts.id,
          expiresAt: artifactMembers.expiresAt,
          role: artifactMembers.role,
          title: artifacts.title,
        })
        .from(artifactMembers)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.id, artifactMembers.artifactId),
            eq(artifacts.workspaceId, artifactMembers.workspaceId)
          )
        )
        .where(
          and(
            eq(artifactMembers.workspaceId, grant.workspaceId),
            eq(artifactMembers.guestId, grant.guestId),
            eq(artifactMembers.principalKind, "guest"),
            isNull(artifactMembers.revokedAt),
            isNull(artifacts.deletedAt),
            inArray(artifacts.kind, ["document", "deck"]),
            gt(artifactMembers.expiresAt, deps.clock.now().toISOString())
          )
        )
        .limit(1000);
      await current(input);
      return rows;
    },
    async metadata(input: GuestCredential) {
      const grant = await current(input);
      const [row] = await deps.db
        .select({ kind: artifacts.kind, title: artifacts.title })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, grant.artifactId),
            eq(artifacts.workspaceId, grant.workspaceId)
          )
        )
        .limit(1);
      if (!row || (row.kind !== "document" && row.kind !== "deck")) {
        throw denied();
      }
      await current(input);
      return { grant, kind: row.kind, title: row.title };
    },
    prepareComment,
    async resolve(input: GuestCredential, threadId: string) {
      const grant = await current(input, true);
      const [thread] = await deps.db
        .select()
        .from(artifactCommentThreads)
        .where(and(scope(grant), eq(artifactCommentThreads.id, threadId)))
        .limit(1);
      if (!thread) {
        throw denied();
      }
      if (thread.resolvedAt) {
        return { resolved: true };
      }
      if (deps.guestsOff()) {
        throw denied();
      }
      await deps.atomic([
        guestArtifactWriteGuard(deps.db, {
          ...grant,
          at: deps.clock.now().toISOString(),
          tokenHash: await hashToken(input.sessionToken),
        }),
        deps.db
          .update(artifactCommentThreads)
          .set({
            resolvedAt: deps.clock.now().toISOString(),
            resolvedBy: `g:${grant.guestId}`,
          })
          .where(and(scope(grant), eq(artifactCommentThreads.id, threadId))),
        ...(deps.events
          ? [
              deps.events.insertStatement({
                actor: { id: grant.guestId, kind: "guest" },
                payload: { artifactId: grant.artifactId, threadId },
                type: "artifact.comment_resolved",
                workspaceId: grant.workspaceId,
              }),
            ]
          : []),
      ]);
      return { resolved: true };
    },
    async resolveReference(input: {
      workspaceId: string;
      artifactId: string;
      sessionId: string;
    }) {
      if (deps.guestsOff()) {
        return null;
      }
      const row = await findGuestSessionReferenceGrant(deps.db, {
        ...input,
        at: deps.clock.now().toISOString(),
      });
      return row
        ? {
            artifactId: row.artifactId,
            displayName: row.guestName,
            expiresAt: row.expiresAt,
            guestId: row.guestId,
            role: row.role,
            workspaceId: row.workspaceId,
          }
        : null;
    },
    async sessionReference(input: GuestCredential) {
      await current(input);
      return findGuestSessionGrant(deps.db, {
        ...input,
        at: deps.clock.now().toISOString(),
        tokenHash: await hashToken(input.sessionToken),
      });
    },
    async threads(input: GuestCredential): Promise<GuestThread[]> {
      const grant = await current(input);
      const rows = await deps.db
        .select()
        .from(artifactCommentThreads)
        .where(scope(grant))
        .orderBy(asc(artifactCommentThreads.id))
        .limit(1000);
      const result = await Promise.all(
        rows.map(async (thread) => ({
          ...thread,
          comments: await deps.db
            .select()
            .from(artifactComments)
            .where(
              and(
                eq(artifactComments.threadId, thread.id),
                eq(artifactComments.workspaceId, grant.workspaceId),
                isNull(artifactComments.deletedAt)
              )
            )
            .orderBy(asc(artifactComments.createdAt))
            .limit(100),
        }))
      );
      await current(input);
      return result;
    },
    async transcript(
      input: GuestCredential,
      after = ""
    ): Promise<{ events: EventRecord[]; sessionId: string | null }> {
      const grant = await current(input);
      const [session] = await deps.db
        .select({ id: sessions.id })
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
      if (!session) {
        return { events: [], sessionId: null };
      }
      const rows = await deps.db
        .select()
        .from(eventRows)
        .where(
          and(
            eq(eventRows.workspaceId, grant.workspaceId),
            eq(eventRows.sessionId, session.id),
            gt(eventRows.id, after)
          )
        )
        .orderBy(asc(eventRows.id))
        .limit(100);
      const events = await Promise.all(
        rows.map(async (row) => {
          const event = toRecord(row);
          if (row.payloadRef) {
            const payload = await deps.payloads?.get(row.payloadRef);
            if (!payload) {
              throw denied();
            }
            event.payload = JSON.parse(payload);
          }
          return event;
        })
      );
      await current(input);
      return {
        events: await resolveActorDisplays(deps.db, undefined, events),
        sessionId: session.id,
      };
    },
  };
};
