import type { TeamSlackStatus } from "@repo/db/shared";
import { useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";

/** The label for a team's Slack link, or null while the room has no link. */
export function slackLinkLabel(status: TeamSlackStatus | null): string | null {
  if (status === null || status.link === null) {
    return null;
  }
  if (status.channelName === null) {
    return "Slack linked";
  }
  return `Slack #${status.channelName}`;
}

/** A small muted line naming the Slack channel a team room is linked to. */
export function SlackLinkBadge({ label }: { label: string }) {
  return <p className="text-muted-foreground text-sm">{label}</p>;
}

/** Reads the team's Slack link label once. It stays null while the room has no link, while loading, and when the lookup fails. */
export function useSlackLinkLabel(teamId: string): string | null {
  const [status, setStatus] = useState<TeamSlackStatus | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(null);
    const load = async (): Promise<void> => {
      try {
        const result = await getTrpc().teams.slack.status.query({ teamId });
        if (active) {
          setStatus(result);
        }
      } catch {
        // The badge is optional, so a failed lookup leaves it hidden.
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [teamId]);

  return slackLinkLabel(status);
}
