import { useCallback, useId, useState } from "react";
import { errorMessage } from "#/components/triggers/format";
import { Label } from "#/components/ui/label";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { getTrpc } from "#/integrations/trpc/client";
import type { SlackAppRecord } from "#/integrations/trpc/types";

export interface ListenModeControlProps {
  app: SlackAppRecord;
  onChanged: () => void;
}

export function ListenModeControl({ app, onChanged }: ListenModeControlProps) {
  const appId = app.id;
  const idPrefix = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleChange = useCallback(
    async (value: string) => {
      const listenMode = value === "all" ? "all" : "mentions";
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().slackApps.setListenMode.mutate({
          id: appId,
          listenMode,
        });
      } catch (cause) {
        setError(errorMessage(cause));
        setSaving(false);
        return;
      }
      setSaving(false);
      onChanged();
    },
    [appId, onChanged]
  );

  return (
    <div className="flex w-full flex-col gap-2">
      <RadioGroup
        disabled={saving}
        onValueChange={handleChange}
        value={app.listenMode}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-mentions`} value="mentions" />
          <Label htmlFor={`${idPrefix}-mentions`}>Mentions only</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-all`} value="all" />
          <Label htmlFor={`${idPrefix}-all`}>
            All messages in its channels
          </Label>
        </div>
      </RadioGroup>
      {error === undefined ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      <p className="text-muted-foreground text-xs">
        In all-messages mode the agent reads every message in the channels it is
        in and can start a run about every five minutes per busy channel, which
        uses model credit; mentions and direct messages still start a run at
        once.
      </p>
      <p className="text-muted-foreground text-xs">
        Stored messages are deleted after 90 days.
      </p>
    </div>
  );
}
