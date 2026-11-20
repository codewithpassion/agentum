import type { RuntimeConfig } from "@repo/services/agents";
import { useRouter } from "@tanstack/react-router";
import { type ChangeEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  CAPABILITY_CHOICES,
  CONTEXT_CHOICES,
  capabilityOf,
  contextOf,
  NOT_SET,
  type PlainChoice,
  THINKING_CHOICES,
  thinkingOf,
  withContextBudget,
  withEffort,
} from "./plain-choices-logic.ts";

const OTHER_MODEL = "other";

function ChoiceField({
  choices,
  description,
  disabled,
  id,
  label,
  notSetLabel,
  onChange,
  otherLabel,
  value,
}: {
  choices: readonly PlainChoice<string>[];
  description: string;
  disabled: boolean;
  id: string;
  label: string;
  /** The label of the option that means no setting. Leave out when there is none. */
  notSetLabel?: string;
  onChange: (value: string) => void;
  /** A value the choices do not cover, shown as its own option so it is not lost. */
  otherLabel?: string;
  value: string;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
    [onChange]
  );
  const chosen = choices.find((choice) => choice.value === value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect disabled={disabled} id={id} onChange={change} value={value}>
        {notSetLabel === undefined ? null : (
          <NativeSelectOption value={NOT_SET}>{notSetLabel}</NativeSelectOption>
        )}
        {otherLabel === undefined ? null : (
          <NativeSelectOption disabled value={OTHER_MODEL}>
            {otherLabel}
          </NativeSelectOption>
        )}
        {choices.map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{chosen?.description ?? description}</FieldDescription>
    </Field>
  );
}

export interface PlainChoicesViewProps {
  disabled: boolean;
  model: string;
  onContext: (value: string) => void;
  onModel: (value: string) => void;
  onThinking: (value: string) => void;
  runtimeConfig: Readonly<Record<string, unknown>>;
}

/** The three choices, as selects. A value that is not set reads "Default", so an agent nobody touched is unchanged. */
export function PlainChoicesView({
  disabled,
  model,
  onContext,
  onModel,
  onThinking,
  runtimeConfig,
}: PlainChoicesViewProps) {
  const capability = capabilityOf(model);
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ChoiceField
        choices={CAPABILITY_CHOICES}
        description="How capable the model is."
        disabled={disabled}
        id="agent-capability"
        label="Capability"
        onChange={onModel}
        otherLabel={capability === null ? `Custom (${model})` : undefined}
        value={capability ?? OTHER_MODEL}
      />
      <ChoiceField
        choices={THINKING_CHOICES}
        description="How long the agent thinks before it answers. Default leaves it to the runtime."
        disabled={disabled}
        id="agent-thinking"
        label="Thinking level"
        notSetLabel="Default"
        onChange={onThinking}
        value={thinkingOf(runtimeConfig)}
      />
      <ChoiceField
        choices={CONTEXT_CHOICES}
        description="How much of the conversation and files the agent loads. Default leaves it to the runtime."
        disabled={disabled}
        id="agent-context"
        label="Context size"
        notSetLabel="Default"
        onChange={onContext}
        value={contextOf(runtimeConfig)}
      />
    </div>
  );
}

/** Saves each choice as soon as it is picked: the model, or `effort` or `contextBudget` in the runtime config. */
export function PlainChoices({
  agentId,
  model,
  runtimeConfig,
}: {
  agentId: string;
  model: string;
  runtimeConfig: RuntimeConfig;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // The config just saved, with the props it was built on. The props lag a
  // render behind the reload, and a second pick in that gap must build on the
  // saved config. Once the props change, they are fresh again.
  const [saved, setSaved] = useState<{
    base: RuntimeConfig;
    next: RuntimeConfig;
  } | null>(null);
  const current = saved?.base === runtimeConfig ? saved.next : runtimeConfig;
  const save = useCallback(
    async (patch: { model: string } | { runtimeConfig: RuntimeConfig }) => {
      setSaving(true);
      try {
        await getTrpc().agents.update.mutate({ id: agentId, patch });
        if ("runtimeConfig" in patch) {
          setSaved({ base: runtimeConfig, next: patch.runtimeConfig });
        }
        await router.invalidate();
        toast.success("Saved");
      } catch (caught) {
        toast.error(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [agentId, router, runtimeConfig]
  );
  const onModel = useCallback(
    (value: string) => save({ model: value }),
    [save]
  );
  // The patch carries the whole config, because an update replaces it.
  const onThinking = useCallback(
    (value: string) => save({ runtimeConfig: withEffort(current, value) }),
    [current, save]
  );
  const onContext = useCallback(
    (value: string) =>
      save({
        runtimeConfig: withContextBudget(current, value),
      }),
    [current, save]
  );
  return (
    <PlainChoicesView
      disabled={saving}
      model={model}
      onContext={onContext}
      onModel={onModel}
      onThinking={onThinking}
      runtimeConfig={current}
    />
  );
}
