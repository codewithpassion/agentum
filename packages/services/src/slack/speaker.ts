import type { Database } from "@repo/db";
import { slackMessages } from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
import { and, eq, or } from "drizzle-orm";
import type { PeopleLookup } from "../events.ts";
import { buildSpeakerEnvelope } from "../speaker-envelope.ts";

/** Signed Slack sender is already linked; other speakers must have current links in this team/workspace. */
export const slackSpeakerText = async (
  db: Database,
  people: PeopleLookup | undefined,
  input: {
    workspaceId: string;
    teamId: string;
    appId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }
): Promise<string> => {
  const rows = await db
    .selectDistinct({ id: identityLinks.clerkUserId })
    .from(slackMessages)
    .innerJoin(
      identityLinks,
      and(
        eq(identityLinks.externalUserId, slackMessages.slackUserId),
        eq(identityLinks.workspaceId, input.workspaceId),
        eq(identityLinks.teamId, input.teamId),
        eq(identityLinks.provider, "slack")
      )
    )
    .where(
      and(
        eq(slackMessages.workspaceId, input.workspaceId),
        eq(slackMessages.appId, input.appId),
        eq(slackMessages.channelId, input.channelId),
        or(
          eq(slackMessages.threadTs, input.threadTs),
          eq(slackMessages.ts, input.threadTs)
        )
      )
    );
  const ids = [...new Set([input.userId, ...rows.map((r) => r.id)])];
  if (ids.length < 2) {
    return input.text;
  }
  const names = people ? await people(ids).catch(() => new Map()) : new Map();
  const present = ids.map((id) => ({
    id,
    kind: "member" as const,
    name: names.get(id)?.name?.trim().slice(0, 200) || "Person",
    role: "member",
  }));
  return buildSpeakerEnvelope(
    {
      actor: { id: input.userId, kind: "user" },
      name: present.find((p) => p.id === input.userId)?.name ?? "Person",
      role: "member",
    },
    { present },
    "slack",
    input.text
  );
};
