import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
  type MemberAuthorView,
  resolveMembersByIds,
} from "#/modules/workspaces/authors";
import type { EXTERNAL_LINK_SOURCES, ExternalAuthor } from "./schema";
import { externalAuthors } from "./schema";

export type ExternalLinkSource = (typeof EXTERNAL_LINK_SOURCES)[number];

/**
 * Putting a face to an `authorType: "external"` author.
 *
 * A bridged message stores who wrote it as the surface names them - `slack:U0A…`
 * - because that is the only identity the surface hands over. This is the seam
 * that turns one into a person: a display name always, and the workspace member
 * they are when that has been worked out.
 *
 * It lives beside `service.ts` for the same reason `workspaces/authors.ts` does:
 * the resolution is a view concern, and keeping it out of the service keeps the
 * write path unaware of it.
 *
 * The connectors write here; nothing in messaging knows which connector a given
 * author came from, and it does not need to - the author id is already unique.
 */

/** What a connector knows about somebody the moment it sees them post. */
export interface ExternalAuthorInput {
  /** Exactly what goes into `messages.author_id`, e.g. `slack:U0AHBBYVAN5`. */
  authorId: string;
  displayName: string;
}

/**
 * Remembers what a surface calls somebody, without touching who they are. The
 * two facts have different owners: the name comes from the surface on every
 * message, the link is decided once - and, when a person fixed it by hand,
 * decided by them.
 */
export const rememberExternalAuthor = async (
  db: Db,
  workspaceId: string,
  input: ExternalAuthorInput
): Promise<{ firstSighting: boolean }> => {
  const existing = await db
    .select({ authorId: externalAuthors.authorId })
    .from(externalAuthors)
    .where(
      and(
        eq(externalAuthors.workspaceId, workspaceId),
        eq(externalAuthors.authorId, input.authorId)
      )
    );

  await db
    .insert(externalAuthors)
    .values({
      authorId: input.authorId,
      displayName: input.displayName,
      workspaceId,
    })
    .onConflictDoUpdate({
      set: { displayName: input.displayName, updatedAt: new Date() },
      target: [externalAuthors.workspaceId, externalAuthors.authorId],
    });

  // Says "worth trying to work out who this is". The automatic match costs a
  // Slack call, so it is spent once per person rather than once per message.
  return { firstSighting: existing.length === 0 };
};

/**
 * Says who an external author is. `auto` is the email match having a guess and
 * refuses to overwrite a `manual` link - somebody correcting the guess is the
 * last word on it, and a later message must not undo them.
 */
export const linkExternalAuthor = async (
  db: Db,
  workspaceId: string,
  input: {
    authorId: string;
    linkSource: ExternalLinkSource;
    memberId: string | null;
  }
): Promise<void> => {
  const where =
    input.linkSource === "auto"
      ? and(
          eq(externalAuthors.workspaceId, workspaceId),
          eq(externalAuthors.authorId, input.authorId),
          isNull(externalAuthors.linkSource)
        )
      : and(
          eq(externalAuthors.workspaceId, workspaceId),
          eq(externalAuthors.authorId, input.authorId)
        );

  await db
    .update(externalAuthors)
    .set({
      linkSource: input.linkSource,
      memberId: input.memberId,
      updatedAt: new Date(),
    })
    .where(where);
};

/** Everyone a connector has seen post here, for the screen that corrects them. */
export const listExternalAuthors = (
  db: Db,
  workspaceId: string
): Promise<ExternalAuthor[]> =>
  db
    .select()
    .from(externalAuthors)
    .where(eq(externalAuthors.workspaceId, workspaceId))
    .orderBy(asc(externalAuthors.displayName));

/**
 * The batched lookup behind every view that shows a bridged message: one query
 * for the external authors in the batch, one more for whichever of them turned
 * out to be members.
 *
 * Unlike `resolveMemberAuthors` this map does *not* answer for every id asked
 * about. A miss is the normal case and means something specific - nobody has
 * ever seen this author, or it is the app signing its own `routine:` post - and
 * the client already knows what to call those.
 */
export const resolveExternalAuthors = async (
  db: Db,
  workspaceId: string,
  authorIds: readonly string[]
): Promise<Map<string, MemberAuthorView>> => {
  const wanted = [...new Set(authorIds)];
  const resolved = new Map<string, MemberAuthorView>();
  if (wanted.length === 0) {
    return resolved;
  }

  const rows = await db
    .select()
    .from(externalAuthors)
    .where(
      and(
        eq(externalAuthors.workspaceId, workspaceId),
        inArray(externalAuthors.authorId, wanted)
      )
    );

  // Linked authors resolve through the members table, so a bridged message
  // carries the same name, avatar and member id a native one would - which is
  // also what lets the client recognise the reader's own messages.
  const members = await resolveMembersByIds(
    db,
    workspaceId,
    rows.flatMap((row) => (row.memberId ? [row.memberId] : []))
  );

  for (const row of rows) {
    const member = row.memberId ? members.get(row.memberId) : undefined;
    // A link whose membership has since been removed falls back to the surface
    // name: "Former member" would lose the one identity we still have.
    resolved.set(
      row.authorId,
      member?.memberId
        ? member
        : {
            email: null,
            imageUrl: null,
            memberId: null,
            name: row.displayName,
          }
    );
  }
  return resolved;
};
