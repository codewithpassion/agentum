import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { runOnSendShortcut } from "#/components/composer/send-shortcut";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";

const MAX_TEXT_LENGTH = 2000;

export interface DescribeJobProps {
  /** Fixes the agent. When undefined, the form asks which agent to use. */
  agentId: string | undefined;
  agents: readonly { id: string; name: string }[];
  /** A draft is being made. */
  busy: boolean;
  error: string | null;
  onSubmit: (agentId: string, text: string) => void;
}

export function DescribeJob({
  agents,
  agentId,
  busy,
  error,
  onSubmit,
}: DescribeJobProps) {
  const [text, setText] = useState("");
  const [chosenAgentId, setChosenAgentId] = useState("");

  const targetAgentId = agentId ?? chosenAgentId;
  const trimmed = text.trim();
  const canSubmit = !busy && trimmed !== "" && targetAgentId !== "";

  const submit = useCallback((): void => {
    if (!canSubmit) {
      return;
    }
    onSubmit(targetAgentId, trimmed);
  }, [canSubmit, onSubmit, targetAgentId, trimmed]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      setText(event.target.value);
    },
    []
  );

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      setChosenAgentId(event.target.value);
    },
    []
  );

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <Label htmlFor="describe-job-text">Describe a new job</Label>
      <Textarea
        id="describe-job-text"
        maxLength={MAX_TEXT_LENGTH}
        onChange={handleTextChange}
        onKeyDown={runOnSendShortcut(canSubmit, submit)}
        placeholder="Every Friday, summarise support tickets for me."
        readOnly={busy}
        rows={2}
        value={text}
      />
      {agentId === undefined ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="describe-job-agent">Agent</Label>
          <NativeSelect
            id="describe-job-agent"
            onChange={handleAgentChange}
            value={chosenAgentId}
          >
            <NativeSelectOption value="">Choose an agent</NativeSelectOption>
            {agents.map((agent) => (
              <NativeSelectOption key={agent.id} value={agent.id}>
                {agent.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button disabled={!canSubmit} type="submit">
        {busy ? "Drafting..." : "Draft job"}
      </Button>
    </form>
  );
}
