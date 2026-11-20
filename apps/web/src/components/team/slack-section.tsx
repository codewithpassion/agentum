import type {
  TeamSlackChannel,
  TeamSlackChannels,
  TeamSlackStatus,
} from "@repo/db/shared";
import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import {
  channelLabel,
  type MissingSlackApp,
  missingSlackApps,
} from "./slack-logic.ts";
import type { TeamAgent } from "./team-logic.ts";

const NOT_LINKED = "This team's room is not linked to a Slack channel.";
const LOADING_CHANNELS = "Loading channels...";
const NO_SLACK_APP =
  "No agent of this team has a Slack app yet. Add a Slack app to an agent, then come back here.";
const NO_CHANNELS =
  "The lead's Slack app is in no channels. Invite it to a channel in Slack first.";
const CHANNEL_LABEL = "Slack channel";
const CHANNEL_HELP =
  "Messages in the channel appear in the team room, and room posts go to the channel. A team links one channel, and a channel links one team.";
const PICK_CHANNEL = "Pick a channel";
const LINK_CHANNEL = "Link channel";
const UNLINK = "Unlink";
const MISSING_HELP =
  "These agents' Slack apps are not in the channel yet. Paste each line in the channel in Slack:";
const NO_APP = "has no Slack app yet";
const ALL_IN_CHANNEL = "Every agent's Slack app is in the channel.";
const CHANNEL_SELECT_ID = "team-slack-channel";
const CHANNEL_HELP_ID = "team-slack-channel-help";
const PRIVATE_SUFFIX = " (private)";

export interface SlackSectionProps {
  agents: readonly TeamAgent[];
  /** A link or unlink call is running. */
  busy: boolean;
  canEdit: boolean;
  /** The channels the lead's Slack app can see. Null until loaded. */
  channels: TeamSlackChannels | null;
  channelsError: string | null;
  error: string | null;
  onLink: (slackTeamId: string, channelId: string) => void;
  onUnlink: () => void;
  status: TeamSlackStatus;
}

const channelOptionLabel = (channel: TeamSlackChannel): string =>
  channel.isPrivate ? `#${channel.name}${PRIVATE_SUFFIX}` : `#${channel.name}`;

const MutedText = ({ children }: { children: string }) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);

const AlertText = ({ children }: { children: string }) => (
  <p className="text-destructive text-sm" role="alert">
    {children}
  </p>
);

/** The channel picker. It keeps the picked channel as local state. */
function ChannelPicker({
  busy,
  channels,
  onLink,
}: {
  busy: boolean;
  channels: TeamSlackChannels;
  onLink: (slackTeamId: string, channelId: string) => void;
}) {
  const [pickedId, setPickedId] = useState("");
  const chosenId = channels.channels.some((channel) => channel.id === pickedId)
    ? pickedId
    : "";

  const handleChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setPickedId(event.target.value);
  }, []);

  const handleLink = useCallback(() => {
    if (channels.slackTeamId !== null && chosenId !== "") {
      onLink(channels.slackTeamId, chosenId);
    }
  }, [channels.slackTeamId, chosenId, onLink]);

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={CHANNEL_SELECT_ID}>{CHANNEL_LABEL}</FieldLabel>
        <NativeSelect
          aria-describedby={CHANNEL_HELP_ID}
          id={CHANNEL_SELECT_ID}
          onChange={handleChange}
          value={chosenId}
        >
          <NativeSelectOption value="">{PICK_CHANNEL}</NativeSelectOption>
          {channels.channels.map((channel) => (
            <NativeSelectOption key={channel.id} value={channel.id}>
              {channelOptionLabel(channel)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription id={CHANNEL_HELP_ID}>{CHANNEL_HELP}</FieldDescription>
      </Field>
      <div>
        <Button
          disabled={busy || chosenId === ""}
          onClick={handleLink}
          type="button"
        >
          {LINK_CHANNEL}
        </Button>
      </div>
    </div>
  );
}

/** What an unlinked room shows: the picker for an editor, a note for a reader. */
function UnlinkedRoom({
  busy,
  canEdit,
  channels,
  channelsError,
  onLink,
}: {
  busy: boolean;
  canEdit: boolean;
  channels: TeamSlackChannels | null;
  channelsError: string | null;
  onLink: (slackTeamId: string, channelId: string) => void;
}) {
  if (!canEdit) {
    return <MutedText>{NOT_LINKED}</MutedText>;
  }
  if (channelsError !== null) {
    return <AlertText>{channelsError}</AlertText>;
  }
  if (channels === null) {
    return <MutedText>{LOADING_CHANNELS}</MutedText>;
  }
  if (channels.slackTeamId === null) {
    return <MutedText>{NO_SLACK_APP}</MutedText>;
  }
  if (channels.channels.length === 0) {
    return <MutedText>{NO_CHANNELS}</MutedText>;
  }
  return <ChannelPicker busy={busy} channels={channels} onLink={onLink} />;
}

function MissingApps({ missing }: { missing: readonly MissingSlackApp[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{MISSING_HELP}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {missing.map((app) => (
          <li className="flex flex-wrap items-baseline gap-2" key={app.agentId}>
            <span className="font-medium">{app.name}</span>
            {app.invite === null ? (
              <span className="text-muted-foreground">{NO_APP}</span>
            ) : (
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
                {app.invite}
              </code>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The missing-apps list, or the all-good line, or nothing when the team has no agent apps. */
function AppStatus({
  apps,
  missing,
}: {
  apps: TeamSlackStatus["apps"];
  missing: readonly MissingSlackApp[];
}) {
  if (missing.length > 0) {
    return <MissingApps missing={missing} />;
  }
  if (apps.length > 0) {
    return <MutedText>{ALL_IN_CHANNEL}</MutedText>;
  }
  return null;
}

/** A linked room: the channel, an unlink button for an editor, and the agents' apps. */
function LinkedRoom({
  agents,
  busy,
  canEdit,
  onUnlink,
  status,
}: {
  agents: readonly TeamAgent[];
  busy: boolean;
  canEdit: boolean;
  onUnlink: () => void;
  status: TeamSlackStatus;
}) {
  const handleUnlink = useCallback(() => {
    onUnlink();
  }, [onUnlink]);

  if (status.link === null) {
    return null;
  }
  const label = channelLabel(status.channelName, status.link.channelId);
  const missing = missingSlackApps(status.apps, agents);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-medium text-sm">{`Linked to ${label}`}</p>
        {canEdit ? (
          <Button
            disabled={busy}
            onClick={handleUnlink}
            type="button"
            variant="outline"
          >
            {UNLINK}
          </Button>
        ) : null}
      </div>
      <AppStatus apps={status.apps} missing={missing} />
    </div>
  );
}

/** The Slack block of the team page. The parent loads the data and runs the calls. */
export function SlackSection({
  agents,
  busy,
  canEdit,
  channels,
  channelsError,
  error,
  onLink,
  onUnlink,
  status,
}: SlackSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      {status.link === null ? (
        <UnlinkedRoom
          busy={busy}
          canEdit={canEdit}
          channels={channels}
          channelsError={channelsError}
          onLink={onLink}
        />
      ) : (
        <LinkedRoom
          agents={agents}
          busy={busy}
          canEdit={canEdit}
          onUnlink={onUnlink}
          status={status}
        />
      )}
      {error === null ? null : <AlertText>{error}</AlertText>}
    </div>
  );
}
