import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { SelectField, TextAreaField, TextField } from "#/components/ui/field";
import type { Agent, Channel, Routine } from "#/lib/api";
import { useApi } from "#/lib/workspace-context";
import {
  browserTimeZone,
  draftFromSchedule,
  emptyDraft,
  type ScheduleDraft,
  SchedulePicker,
  scheduleFromDraft,
} from "./schedule-picker";

/**
 * Writing a routine: who runs it, where, what it is told to do, and when.
 *
 * Nothing is validated here that the server validates - the schedule goes
 * through the same parser either way, and the preview above the buttons is the
 * honest answer to "when will this actually fire", so a save that the API would
 * refuse is visible before it is attempted.
 *
 * The picker itself is made of two things the server cannot know - this
 * browser's time zone and its clock - so it is filled in on mount rather than
 * server-rendered into text that hydration would then have to disagree with.
 */

const NAME_MAX_LENGTH = 120;
const INSTRUCTIONS_MAX_LENGTH = 10_000;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Failed to save the routine.";

/** A target that has been deleted still has to be nameable, or editing loses it. */
function TargetOptions({
  currentId,
  items,
  missingLabel,
}: {
  currentId: string;
  items: { id: string; name: string }[];
  missingLabel: string;
}) {
  const known = items.some((item) => item.id === currentId);
  return (
    <>
      {known || currentId === "" ? null : (
        <option value={currentId}>{missingLabel}</option>
      )}
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </>
  );
}

/** The picker's two halves, adopted together once the browser is available. */
interface ScheduleState {
  draft: ScheduleDraft;
  timezone: string;
}

export function RoutineForm({
  agents,
  channels,
  onCancel,
  onSaved,
  routine,
}: {
  agents: Agent[];
  channels: Channel[];
  onCancel: () => void;
  onSaved: (routine: Routine) => Promise<void>;
  /** Null writes a new routine; a row edits it in place. */
  routine: Routine | null;
}) {
  const api = useApi();

  const [name, setName] = useState(routine ? routine.name : "");
  const [agentId, setAgentId] = useState(routine ? routine.agentId : "");
  const [channelId, setChannelId] = useState(routine ? routine.channelId : "");
  const [instructions, setInstructions] = useState(
    routine ? routine.instructions : ""
  );
  const [schedule, setSchedule] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The pickers' lists arrive after the form mounts, so "nothing chosen yet"
  // has to mean whatever the control is actually showing - its first option -
  // rather than an empty string the server would refuse.
  const chosenAgentId = agentId || (agents.at(0)?.id ?? "");
  const chosenChannelId = channelId || (channels.at(0)?.id ?? "");

  // Once, on mount: an edit starts from the stored schedule, a new routine from
  // this browser's zone and clock.
  useEffect(() => {
    setSchedule(
      (current) =>
        current ?? {
          draft: routine ? draftFromSchedule(routine.schedule) : emptyDraft(),
          timezone: routine ? routine.timezone : browserTimeZone(),
        }
    );
  }, [routine]);

  const onDraftChange = useCallback((draft: ScheduleDraft) => {
    setSchedule((current) => (current ? { ...current, draft } : current));
  }, []);
  const onTimezoneChange = useCallback((timezone: string) => {
    setSchedule((current) => (current ? { ...current, timezone } : current));
  }, []);

  const onName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const onAgent = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setAgentId(event.target.value),
    []
  );
  const onChannel = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setChannelId(event.target.value),
    []
  );
  const onInstructions = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) =>
      setInstructions(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!schedule) {
        return;
      }
      const parsed = scheduleFromDraft(schedule.draft);
      if (!parsed.ok) {
        setError(parsed.reason);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const input = {
          agentId: chosenAgentId,
          channelId: chosenChannelId,
          instructions,
          name: name.trim(),
          schedule: parsed.schedule,
          timezone: schedule.timezone,
        };
        const saved = routine
          ? await api.updateRoutine(routine.id, input)
          : await api.createRoutine(input);
        await onSaved(saved);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      api,
      chosenAgentId,
      chosenChannelId,
      instructions,
      name,
      onSaved,
      routine,
      schedule,
    ]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <form className="mx-auto max-w-2xl space-y-5" onSubmit={submit}>
        <header className="space-y-1">
          <h2 className="m-0 font-semibold text-lg">
            {routine ? "Edit routine" : "New routine"}
          </h2>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            When a routine fires, its instructions are posted into the channel
            mentioning the agent. The agent answers in the thread under them.
          </p>
        </header>

        <TextField
          data-testid="routine-name"
          label="Name"
          maxLength={NAME_MAX_LENGTH}
          onChange={onName}
          placeholder="Morning ops summary"
          required
          value={name}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            data-testid="routine-agent"
            label="Agent"
            onChange={onAgent}
            required
            value={chosenAgentId}
          >
            <TargetOptions
              currentId={chosenAgentId}
              items={agents}
              missingLabel="(deleted agent)"
            />
          </SelectField>
          <SelectField
            data-testid="routine-channel"
            label="Channel"
            onChange={onChannel}
            required
            value={chosenChannelId}
          >
            <TargetOptions
              currentId={chosenChannelId}
              items={channels}
              missingLabel="(deleted channel)"
            />
          </SelectField>
        </div>

        <TextAreaField
          data-testid="routine-instructions"
          hint="What the agent is asked to do, in your words."
          label="Instructions"
          maxLength={INSTRUCTIONS_MAX_LENGTH}
          onChange={onInstructions}
          placeholder="Summarise yesterday's activity in this channel and flag anything unanswered."
          required
          rows={5}
          value={instructions}
        />

        {schedule ? (
          <SchedulePicker
            draft={schedule.draft}
            onDraftChange={onDraftChange}
            onTimezoneChange={onTimezoneChange}
            timezone={schedule.timezone}
          />
        ) : null}

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button
            data-testid="routine-save"
            disabled={busy}
            type="submit"
            variant="primary"
          >
            {routine ? "Save routine" : "Create routine"}
          </Button>
        </div>
      </form>
    </div>
  );
}
