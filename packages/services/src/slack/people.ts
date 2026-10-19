import type { Database } from "@repo/db";
import { identityLinks } from "@repo/db/schema/workspaces";
import { and, eq } from "drizzle-orm";
import type { SlackClient } from "./client.ts";

export interface LinkedPerson {
  /** Other names Slack knows the person by, for matching an @name. */
  aliases: string[];
  email: string;
  externalUserId: string;
  /** The Slack name, or the email when Slack gave none. */
  slackName: string;
}

/** Linked people of one workspace in one Slack team, with their Slack names. */
export const linkedPeople = async (
  db: Database,
  client: SlackClient,
  team: { teamId: string; workspaceId: string }
): Promise<LinkedPerson[]> => {
  const links = await db
    .select({
      email: identityLinks.email,
      externalUserId: identityLinks.externalUserId,
    })
    .from(identityLinks)
    .where(
      and(
        eq(identityLinks.workspaceId, team.workspaceId),
        eq(identityLinks.provider, "slack"),
        eq(identityLinks.teamId, team.teamId)
      )
    );
  return Promise.all(
    links.map(async (link) => {
      const name = await client.userName(link.externalUserId);
      if (name.kind === "ok") {
        return {
          aliases: name.aliases,
          email: link.email,
          externalUserId: link.externalUserId,
          slackName: name.name ?? link.email,
        };
      }
      return {
        aliases: [],
        email: link.email,
        externalUserId: link.externalUserId,
        slackName: link.email,
      };
    })
  );
};
