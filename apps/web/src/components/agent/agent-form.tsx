import { CLOUD_MODELS, findCloudModel } from "@repo/services/cloud/models";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { NativeSelect } from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";
import type { MachineRecord } from "#/integrations/trpc/types";

export interface AgentFormValues {
  instructions: string;
  machineId: string;
  model: string;
  name: string;
  runtime: "cloud" | "fake" | "machine" | "managed";
}

const defaultValues: AgentFormValues = {
  instructions: "",
  machineId: "",
  model: "sonnet",
  name: "",
  runtime: import.meta.env.DEV ? "fake" : "machine",
};

interface AgentFormProps {
  initial?: AgentFormValues;
  lockRuntime?: boolean;
  machines: MachineRecord[];
  onSubmit: (values: AgentFormValues) => Promise<void>;
  submitLabel: string;
}

function toRuntime(value: string): AgentFormValues["runtime"] {
  if (value === "cloud" || value === "fake" || value === "managed") {
    return value;
  }
  return "machine";
}

export function AgentForm({
  initial = defaultValues,
  lockRuntime = false,
  machines,
  onSubmit,
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
  const handleMachine = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      update("machineId", event.target.value),
    [update]
  );

  const selectable = machines.filter((machine) => machine.status !== "revoked");
  const cloudAlias = findCloudModel(values.model)?.alias ?? "";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
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
    [onSubmit, values]
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
          <Textarea
            id="agent-instructions"
            onChange={handleInstructions}
            value={values.instructions}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-model">Model</FieldLabel>
          {values.runtime === "cloud" ? (
            <NativeSelect
              id="agent-model"
              onChange={handleCloudModel}
              required
              value={cloudAlias}
            >
              {cloudAlias === "" && <option value="">Choose a model</option>}
              {CLOUD_MODELS.map((entry) => (
                <option key={entry.alias} value={entry.alias}>
                  {entry.label}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              id="agent-model"
              onChange={handleModel}
              value={values.model}
            />
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
              the workspace's Anthropic API key (Settings, Managed Agents). It
              cannot read attached files, does not get this workspace's skills,
              and [ATTACHMENT:path] in its answers stays plain text. Images
              returned by connector tools never reach the model. A session stops
              at $10 of spend.
            </FieldDescription>
          )}
          {values.runtime === "cloud" && (
            <FieldDescription>
              Runs on Cloudflare, not on one of your machines. It has no shell
              and no local files, but it can use library bash, connectors and
              this workspace's skills. It runs a skill's TypeScript or
              JavaScript scripts in a short-lived sandbox with network access
              and no secrets of yours (a script imports only its own skill
              files, and stops after 30 seconds). It sees attached images (about
              1 MB in total) and can read attached text files. It returns a file
              when it writes it to the library and puts
              [ATTACHMENT:/library/path] in its answer.
            </FieldDescription>
          )}
        </Field>
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
                No machines yet. <Link to="/machines">Enrol a machine</Link>{" "}
                first.
              </FieldDescription>
            )}
          </Field>
        )}
      </FieldGroup>
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button disabled={pending} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}
