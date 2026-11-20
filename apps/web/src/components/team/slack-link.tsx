import type { TeamSlackChannels, TeamSlackStatus } from "@repo/db/shared";
import { useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message.ts";
import { SlackSection } from "./slack-section.tsx";
import type { TeamAgent } from "./team-logic.ts";

const LOADING_TEXT = "Loading Slack...";

/**
 * The team's Slack link. It reads the link and the member apps when it mounts,
 * and the channels the lead's app can see when the team has no link and the
 * caller may link one. Slack answers slowly, so none of this waits on the
 * page's loader.
 */
export function SlackLink({
  agents,
  canEdit,
  teamId,
}: {
  agents: readonly TeamAgent[];
  canEdit: boolean;
  teamId: string;
}) {
  const [status, setStatus] = useState<TeamSlackStatus | null>(null);
  const [channels, setChannels] = useState<TeamSlackChannels | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getTrpc().teams.slack.status.query({ teamId }));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [teamId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const needsChannels = canEdit && status !== null && status.link === null;
  useEffect(() => {
    if (!needsChannels) {
      return;
    }
    let current = true;
    setChannels(null);
    setChannelsError(null);
    getTrpc()
      .teams.slack.channels.query({ teamId })
      .then((result) => {
        if (current) {
          setChannels(result);
        }
      })
      .catch((caught: unknown) => {
        if (current) {
          setChannelsError(errorMessage(caught));
        }
      });
    return () => {
      current = false;
    };
  }, [needsChannels, teamId]);

  const change = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
        await loadStatus();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [loadStatus]
  );

  const link = useCallback(
    (slackTeamId: string, channelId: string) =>
      change(() =>
        getTrpc().teams.slack.link.mutate({ channelId, slackTeamId, teamId })
      ),
    [change, teamId]
  );
  const unlink = useCallback(
    () => change(() => getTrpc().teams.slack.unlink.mutate({ teamId })),
    [change, teamId]
  );

  if (status === null) {
    return error === null ? (
      <p className="text-muted-foreground text-sm">{LOADING_TEXT}</p>
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  }
  return (
    <SlackSection
      agents={agents}
      busy={busy}
      canEdit={canEdit}
      channels={channels}
      channelsError={channelsError}
      error={error}
      onLink={link}
      onUnlink={unlink}
      status={status}
    />
  );
}
