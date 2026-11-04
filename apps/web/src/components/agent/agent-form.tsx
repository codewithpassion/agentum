import type { ModelProvider } from "@repo/db/shared";
import {
  MAX_TURNS_DEFAULT,
  MAX_TURNS_MAX,
  MAX_TURNS_MIN,
} from "@repo/protocol/safeguards";
import {
  CLOUD_DEFAULT_ENVIRONMENT,
  CLOUD_ENVIRONMENTS,
  type CloudEnvironment,
  isCloudEnvironment,
} from "@repo/services/cloud/environment";
import {
  CLOUD_MODELS,
  CLOUD_PROVIDER_LABELS,
  type CloudModel,
  type CloudProvider,
  cloudModelValue,
  findCloudModel,
} from "@repo/services/cloud/models";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { SubmitKeys } from "#/components/composer/submit-keys";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import { Button } from "#/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import type { MachineRecord } from "#/integrations/trpc/types";

export interface AgentFormValues {
  environment: CloudEnvironment;
  instructions: string;
  machineId: string;
  maxTurns: string;
  model: string;
  name: string;
  networkAccess: boolean;
  runtime: "cloud" | "fake" | "machine" | "managed";
}

const defaultValues: AgentFormValues = {
  environment: CLOUD_DEFAULT_ENVIRONMENT,
  instructions: "",
  machineId: "",
  maxTurns: "",
  model: "sonnet",
  name: "",
  networkAccess: true,
  runtime: import.meta.env.DEV ? "fake" : "machine",
};

interface AgentFormProps {
  /** Shown beside the submit button on phones only (sticky footer). */
  extraAction?: ReactNode;
  initial?: AgentFormValues;
  lockRuntime?: boolean;
  machines: MachineRecord[];
  onSubmit: (values: AgentFormValues) => Promise<void>;
  providerKeys: Record<ModelProvider, boolean>;
  submitLabel: string;
}

function toRuntime(value: string): AgentFormValues["runtime"] {
  if (value === "cloud" || value === "fake" || value === "managed") {
    return value;
  }
  return "machine";
}

interface ProviderGroup {
  models: CloudModel[];
  provider: CloudProvider;
}

function groupByProvider(models: readonly CloudModel[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const model of models) {
    const group = groups.find((entry) => entry.provider === model.provider);
    if (group) {
      group.models.push(model);
    } else {
      groups.push({ models: [model], provider: model.provider });
    }
  }
  return groups;
}

const CLOUD_PROVIDER_GROUPS = groupByProvider(CLOUD_MODELS);

function isMissingKey(
  provider: CloudProvider,
  providerKeys: Record<ModelProvider, boolean>
): boolean {
  return provider !== "anthropic" && providerKeys[provider] !== true;
}

function groupLabel(
  provider: CloudProvider,
  providerKeys: Record<ModelProvider, boolean>
): string {
  const label = CLOUD_PROVIDER_LABELS[provider];
  return isMissingKey(provider, providerKeys) ? `${label} (no API key)` : label;
}

function CloudModelGroup({
  group,
  providerKeys,
}: {
  group: ProviderGroup;
  providerKeys: Record<ModelProvider, boolean>;
}) {
  return (
    <NativeSelectOptGroup label={groupLabel(group.provider, providerKeys)}>
      {group.models.map((entry) => (
        <NativeSelectOption
          key={cloudModelValue(entry)}
          value={cloudModelValue(entry)}
        >
          {entry.label}
        </NativeSelectOption>
      ))}
    </NativeSelectOptGroup>
  );
}

function CloudModelNote({
  entry,
  providerKeys,
}: {
  entry: CloudModel;
  providerKeys: Record<ModelProvider, boolean>;
}) {
  const missingKey = isMissingKey(entry.provider, providerKeys);
  const label = CLOUD_PROVIDER_LABELS[entry.provider];
  return (
    <FieldDescription>
      {entry.description}
      {missingKey
        ? ` This workspace has no ${label} API key. Add one in Settings, Model providers.`
        : null}
    </FieldDescription>
  );
}

export function AgentForm({
  initial = defaultValues,
  extraAction,
  lockRuntime = false,
  machines,
  onSubmit,
  providerKeys,
  submitLabel,
}: AgentFormProps) {
  const [values, setValues] = useState<AgentFormValues>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    <K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) =>
      setValues((current) => ({ ...current, [key]: value })),
    []
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: pending,
    getValue: () => values.instructions,
    inputRef,
    setValue: (value) => update("instructions", value),
  });
  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      update("name", event.target.value),
    [update]
  );
  const handleInstructions = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      update("instructions", event.target.value),
    [update]
  );
  const handleModel = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      update("model", event.target.value),
    [update]
  );
  const handleCloudModel = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      update("model", event.target.value),
    [update]
  );
  const handleRuntime = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      update("runtime", toRuntime(event.target.value)),
    [update]
  );
  const handleEnvironment = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      if (isCloudEnvironment(next)) {
        update("environment", next);
      }
    },
    [update]
  );
  const handleNetworkAccess = useCallback(
    (checked: boolean) => update("networkAccess", checked),
    [update]
  );
  const handleMachine = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      update("machineId", event.target.value),
    [update]
  );
  const handleMaxTurns = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      update("maxTurns", event.target.value),
    [update]
  );

  const selectable = machines.filter(
    (machine) =>
      machine.status !== "revoked" && machine.roles.includes("agent_host")
  );
  const found = findCloudModel(values.model);
  const cloudValue = found ? cloudModelValue(found) : "";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending || dictation.busy) {
        return;
      }
      setPending(true);
      setError(null);
      try {
        await onSubmit(values);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Something went wrong."
        );
      } finally {
        setPending(false);
      }
    },
    [onSubmit, pending, dictation.busy, values]
  );

  return (
    <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            onChange={handleName}
            required
            value={values.name}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
          <div className="relative">
            <Textarea
              id="agent-instructions"
              onChange={handleInstructions}
              onKeyDown={submitOnSendShortcut}
              readOnly={dictation.busy}
              ref={inputRef}
              value={values.instructions}
            />
            <DictationPreview dictation={dictation} />
          </div>
          <DictationButton dictation={dictation} />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-model">Model</FieldLabel>
          {values.runtime === "cloud" ? (
            <NativeSelect
              id="agent-model"
              onChange={handleCloudModel}
              required
              value={cloudValue}
            >
              {cloudValue === "" && <option value="">Choose a model</option>}
              {CLOUD_PROVIDER_GROUPS.map((group) => (
                <CloudModelGroup
                  group={group}
                  key={group.provider}
                  providerKeys={providerKeys}
                />
              ))}
            </NativeSelect>
          ) : (
            <Input
              id="agent-model"
              onChange={handleModel}
              value={values.model}
            />
          )}
          {values.runtime === "cloud" && found !== undefined && (
            <CloudModelNote entry={found} providerKeys={providerKeys} />
          )}
          {values.runtime === "managed" && (
            <FieldDescription>Use opus, sonnet or haiku.</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-runtime">Runtime</FieldLabel>
          <NativeSelect
            disabled={lockRuntime}
            id="agent-runtime"
            onChange={handleRuntime}
            value={values.runtime}
          >
            <option value="machine">machine</option>
            <option value="managed">managed (Anthropic cloud)</option>
            <option value="cloud">cloud (Cloudflare)</option>
            {import.meta.env.DEV ? <option value="fake">fake</option> : null}
          </NativeSelect>
          {values.runtime === "managed" && (
            <FieldDescription>
              Runs on Anthropic's cloud, not on one of your machines. It needs
              the workspace's Anthropic API key (Settings, Anthropic API key).
              It cannot read attached files. It gets this workspace's skills
              with all their files, and TypeScript scripts in a skill run with
              bun in its sandbox. [ATTACHMENT:path] in its answers stays plain
              text. Images returned by connector tools never reach the model. A
              session stops at $10 of spend.
            </FieldDescription>
          )}
          {values.runtime === "cloud" && (
            <FieldDescription>
              Runs on Cloudflare, not on one of your machines. In the isolate
              environment it has no shell (the Environment setting below can
              give it a Linux VM) and no local files, but it can use library
              bash, connectors and this workspace's skills. It runs a skill's
              TypeScript or JavaScript scripts in a short-lived sandbox with
              network access and no secrets of yours (a script imports only its
              own skill files, and stops after 30 seconds). It sees attached
              images (about 1 MB in total) and can read attached text files. It
              returns a file when it writes it to its task folder in the
              library, and everything there shows in the task's Files panel.
            </FieldDescription>
          )}
        </Field>
        {values.runtime === "cloud" && (
          <Field>
            <FieldLabel htmlFor="agent-environment">Environment</FieldLabel>
            <NativeSelect
              id="agent-environment"
              onChange={handleEnvironment}
              value={values.environment}
            >
              {CLOUD_ENVIRONMENTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              The isolate is the default: it starts in milliseconds, costs
              almost nothing and has no shell. A Linux VM is a real Linux
              machine with a shell, bun and node, but it takes a few seconds to
              start and is billed while it runs. The VM sleeps after a few
              minutes idle, and its /workspace folder comes back on the next
              message. Scripts and commands in the VM have network access and
              never see this platform's secrets.
            </FieldDescription>
          </Field>
        )}
        {values.runtime === "cloud" && (
          <Field>
            <FieldLabel htmlFor="agent-network">Network access</FieldLabel>
            <Switch
              checked={values.networkAccess}
              id="agent-network"
              onCheckedChange={handleNetworkAccess}
            />
            <FieldDescription>
              Lets this agent fetch web pages and call APIs from the isolate
              with web_fetch and curl, with private and internal addresses
              blocked. Linux VM agents always have network access, whatever this
              says.
            </FieldDescription>
          </Field>
        )}
        {values.runtime === "machine" && (
          <Field>
            <FieldLabel htmlFor="agent-machine">Machine</FieldLabel>
            <NativeSelect
              id="agent-machine"
              onChange={handleMachine}
              required
              value={values.machineId}
            >
              <option value="">Choose a machine</option>
              {selectable.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {`${machine.name} (${machine.status})`}
                </option>
              ))}
            </NativeSelect>
            {selectable.length === 0 && (
              <FieldDescription>
                No machines yet.{" "}
                <Link to="/settings/machines">Enrol a machine</Link> first.
              </FieldDescription>
            )}
          </Field>
        )}
        {(values.runtime === "cloud" || values.runtime === "machine") && (
          <Field>
            <FieldLabel htmlFor="agent-max-turns">Turn limit</FieldLabel>
            <Input
              id="agent-max-turns"
              max={MAX_TURNS_MAX}
              min={MAX_TURNS_MIN}
              onChange={handleMaxTurns}
              placeholder={String(MAX_TURNS_DEFAULT)}
              step={1}
              type="number"
              value={values.maxTurns}
            />
            <FieldDescription>
              The most model turns one run may take before it is stopped as
              failed. Leave it empty for the default of {MAX_TURNS_DEFAULT}, or
              set a number from {MAX_TURNS_MIN} to {MAX_TURNS_MAX}.
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="sticky -bottom-6 z-10 -mx-4 flex flex-wrap items-center gap-2 border-border border-t bg-background px-4 pt-3 pb-9 md:contents">
        <Button disabled={pending || dictation.busy} type="submit">
          {submitLabel}
          <SubmitKeys />
        </Button>
        {extraAction === undefined ? null : (
          <span className="md:hidden">{extraAction}</span>
        )}
      </div>
    </form>
  );
}
