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
  runtime: "fake" | "machine";
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
  return value === "fake" ? "fake" : "machine";
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
          <Input id="agent-model" onChange={handleModel} value={values.model} />
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
            {import.meta.env.DEV ? <option value="fake">fake</option> : null}
          </NativeSelect>
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
