import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { runOnSendShortcut } from "#/components/composer/send-shortcut";
import { SubmitKeys } from "#/components/composer/submit-keys";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import {
  compilePreset,
  PRESET_KINDS,
  PRESET_LABELS,
  type Preset,
} from "./presets.ts";

export type CreatedRoutine = RouterOutputs["routines"]["create"];

type PresetKind = Preset["kind"];
type ScheduleKind = PresetKind | "custom";
type NumberField = "minutes" | "minute" | "hour" | "day" | "weekday";
type FieldValues = Record<NumberField, number>;
type FieldChangeEvent = ChangeEvent<HTMLInputElement | HTMLSelectElement>;

const SCHEDULE_KINDS: readonly string[] = [...PRESET_KINDS, "custom"];

const isScheduleKind = (value: string): value is ScheduleKind =>
  SCHEDULE_KINDS.includes(value);

const NUMBER_FIELDS: readonly string[] = [
  "minutes",
  "minute",
  "hour",
  "day",
  "weekday",
];

const isNumberField = (name: string): name is NumberField =>
  NUMBER_FIELDS.includes(name);

const FIELDS_BY_KIND: Record<PresetKind, readonly NumberField[]> = {
  daily: ["hour", "minute"],
  everyMinutes: ["minutes"],
  hourly: ["minute"],
  monthly: ["day", "hour", "minute"],
  weekdays: ["hour", "minute"],
  weekly: ["weekday", "hour", "minute"],
};

const FIELD_SPECS: Record<
  NumberField,
  { label: string; min: number; max: number }
> = {
  day: { label: "Day of month", max: 28, min: 1 },
  hour: { label: "Hour", max: 23, min: 0 },
  minute: { label: "Minute", max: 59, min: 0 },
  minutes: { label: "Every (minutes)", max: 59, min: 1 },
  weekday: { label: "Weekday", max: 6, min: 0 },
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DEFAULT_FIELDS: FieldValues = {
  day: 1,
  hour: 9,
  minute: 0,
  minutes: 5,
  weekday: 1,
};

const toPreset = (kind: PresetKind, fields: FieldValues): Preset => {
  switch (kind) {
    case "everyMinutes":
      return { kind, minutes: fields.minutes };
    case "hourly":
      return { kind, minute: fields.minute };
    case "daily":
      return { hour: fields.hour, kind, minute: fields.minute };
    case "weekdays":
      return { hour: fields.hour, kind, minute: fields.minute };
    case "weekly":
      return {
        hour: fields.hour,
        kind,
        minute: fields.minute,
        weekday: fields.weekday,
      };
    case "monthly":
      return {
        day: fields.day,
        hour: fields.hour,
        kind,
        minute: fields.minute,
      };
    default:
      throw new Error("Unknown preset kind");
  }
};

/** The cron expression for the schedule, or null when it is incomplete or invalid. */
const buildCron = (
  kind: ScheduleKind,
  fields: FieldValues,
  customCron: string
): string | null => {
  if (kind === "custom") {
    const cron = customCron.trim();
    return cron === "" ? null : cron;
  }
  try {
    return compilePreset(toPreset(kind, fields));
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
};

function ScheduleField({
  field,
  value,
  onChange,
}: {
  field: NumberField;
  value: number;
  onChange: (event: FieldChangeEvent) => void;
}) {
  const id = `routine-${field}`;
  const spec = FIELD_SPECS[field];

  if (field === "weekday") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{spec.label}</Label>
        <NativeSelect
          id={id}
          name={field}
          onChange={onChange}
          value={String(value)}
        >
          {WEEKDAY_NAMES.map((weekday, index) => (
            <NativeSelectOption key={weekday} value={String(index)}>
              {weekday}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{spec.label}</Label>
      <Input
        id={id}
        max={spec.max}
        min={spec.min}
        name={field}
        onChange={onChange}
        type="number"
        value={Number.isNaN(value) ? "" : value}
      />
    </div>
  );
}

function ScheduleFields({
  kind,
  fields,
  customCron,
  onKindChange,
  onFieldChange,
  onCustomCronChange,
}: {
  kind: ScheduleKind;
  fields: FieldValues;
  customCron: string;
  onKindChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onFieldChange: (event: FieldChangeEvent) => void;
  onCustomCronChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="routine-schedule">Schedule</Label>
        <NativeSelect
          id="routine-schedule"
          onChange={onKindChange}
          value={kind}
        >
          {PRESET_KINDS.map((presetKind) => (
            <NativeSelectOption key={presetKind} value={presetKind}>
              {PRESET_LABELS[presetKind]}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="custom">Custom cron</NativeSelectOption>
        </NativeSelect>
      </div>
      {kind === "custom" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="routine-cron">Cron expression</Label>
          <Input
            id="routine-cron"
            onChange={onCustomCronChange}
            placeholder="0 9 * * 1-5"
            value={customCron}
          />
        </div>
      ) : (
        FIELDS_BY_KIND[kind].map((field) => (
          <ScheduleField
            field={field}
            key={field}
            onChange={onFieldChange}
            value={fields[field]}
          />
        ))
      )}
    </>
  );
}

export function CreateRoutineDialog({
  agentId,
  agents = [],
  onClose,
  onCreated,
}: {
  /** Fixes the agent. When undefined, the dialog asks for one from `agents`. */
  agentId?: string;
  agents?: readonly { id: string; name: string }[];
  onClose: () => void;
  onCreated: (created: CreatedRoutine) => void;
}) {
  const [name, setName] = useState("");
  const [chosenAgentId, setChosenAgentId] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [fields, setFields] = useState<FieldValues>(DEFAULT_FIELDS);
  const [customCron, setCustomCron] = useState("");
  const [timezone, setTimezone] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: pending,
    getValue: () => prompt,
    inputRef,
    setValue: setPrompt,
  });
  const targetAgentId = agentId ?? chosenAgentId;
  const cron = buildCron(kind, fields, customCron);
  const canCreate =
    !(pending || dictation.busy) &&
    name.trim() !== "" &&
    targetAgentId !== "" &&
    prompt.trim() !== "" &&
    cron !== null;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
    },
    []
  );

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setChosenAgentId(event.target.value);
    },
    []
  );

  const handleKindChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      if (isScheduleKind(next)) {
        setKind(next);
      }
    },
    []
  );

  const handleFieldChange = useCallback((event: FieldChangeEvent) => {
    const { name: field, value } = event.target;
    if (!isNumberField(field)) {
      return;
    }
    const parsed = value.trim() === "" ? Number.NaN : Number(value);
    setFields((previous) => ({ ...previous, [field]: parsed }));
  }, []);

  const handleCustomCronChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setCustomCron(event.target.value);
    },
    []
  );

  const handleTimezoneChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTimezone(event.target.value);
    },
    []
  );

  const handlePromptChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(event.target.value);
    },
    []
  );

  const createRoutine = useCallback(async () => {
    if (!canCreate) {
      return;
    }
    const zone = timezone.trim();
    setPending(true);
    setError(null);
    try {
      const created = await getTrpc().routines.create.mutate({
        agentId: targetAgentId,
        cron,
        name: name.trim(),
        prompt: prompt.trim(),
        ...(zone === "" ? {} : { timezone: zone }),
      });
      onCreated(created);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [canCreate, cron, name, onCreated, prompt, targetAgentId, timezone]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create routine</DialogTitle>
          <DialogDescription>
            A routine starts the agent on a schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-name">Name</Label>
            <Input id="routine-name" onChange={handleNameChange} value={name} />
          </div>
          {agentId === undefined ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-agent">Agent</Label>
              <NativeSelect
                id="routine-agent"
                onChange={handleAgentChange}
                value={chosenAgentId}
              >
                <NativeSelectOption value="">
                  Choose an agent
                </NativeSelectOption>
                {agents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <ScheduleFields
            customCron={customCron}
            fields={fields}
            kind={kind}
            onCustomCronChange={handleCustomCronChange}
            onFieldChange={handleFieldChange}
            onKindChange={handleKindChange}
          />
          {cron === null ? null : (
            <p className="font-mono text-muted-foreground text-sm">{cron}</p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-timezone">Timezone</Label>
            <Input
              id="routine-timezone"
              onChange={handleTimezoneChange}
              placeholder="Europe/Zurich"
              value={timezone}
            />
            <p className="text-muted-foreground text-sm">
              Leave empty to use the workspace timezone.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-prompt">Prompt</Label>
            <div className="relative">
              <Textarea
                id="routine-prompt"
                onChange={handlePromptChange}
                onKeyDown={runOnSendShortcut(canCreate, createRoutine)}
                readOnly={dictation.busy}
                ref={inputRef}
                value={prompt}
              />
              <DictationPreview dictation={dictation} />
            </div>
            <DictationButton dictation={dictation} />
            <p className="text-muted-foreground text-sm">
              What the agent is asked each time the routine runs
            </p>
          </div>
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button disabled={!canCreate} onClick={createRoutine}>
              Create routine
              <SubmitKeys />
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
