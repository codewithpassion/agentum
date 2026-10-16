import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";

export interface SlackPasteFormProps {
  agentId: string;
  onPasted: () => void;
}

export function SlackPasteForm({ agentId, onPasted }: SlackPasteFormProps) {
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const canSubmit =
    !sending && botToken.trim() !== "" && signingSecret.trim() !== "";

  const handleBotTokenChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setBotToken(event.target.value),
    []
  );

  const handleSigningSecretChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setSigningSecret(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSending(true);
      setError(undefined);
      try {
        await getTrpc().slackApps.paste.mutate({
          agentId,
          botToken,
          signingSecret,
        });
      } catch (cause) {
        setError(errorMessage(cause));
        setSending(false);
        return;
      }
      // The secrets leave component state as soon as the server has them.
      setBotToken("");
      setSigningSecret("");
      setSending(false);
      onPasted();
    },
    [agentId, botToken, onPasted, signingSecret]
  );

  return (
    <form className="flex max-w-md flex-col gap-3" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slack-bot-token">Bot token</Label>
        <Input
          autoComplete="off"
          id="slack-bot-token"
          onChange={handleBotTokenChange}
          placeholder="xoxb-..."
          type="password"
          value={botToken}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slack-signing-secret">Signing secret</Label>
        <Input
          autoComplete="off"
          id="slack-signing-secret"
          onChange={handleSigningSecretChange}
          type="password"
          value={signingSecret}
        />
      </div>
      {error !== undefined && (
        <p className="text-destructive text-sm">{error}</p>
      )}
      <div>
        <Button disabled={!canSubmit} type="submit">
          Connect Slack
        </Button>
      </div>
    </form>
  );
}
