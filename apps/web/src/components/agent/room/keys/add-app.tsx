import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  type AddChoice,
  addChoices,
  catalogAllowedTools,
  choiceValue,
} from "./add-app-logic.ts";

type AddAppProps = Parameters<typeof addChoices>[0] & {
  agentId: string;
  /** Called after the app is added, so the page can reload. */
  onAdded: () => void;
};

/**
 * Adds an app to the agent: pick one from the catalogue (an admin makes its
 * connector first) or one the workspace already has, then assign it.
 */
export function AddApp({
  agentId,
  assignedIds,
  catalog,
  connectors,
  isAdmin,
  onAdded,
}: AddAppProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const choices = addChoices({ assignedIds, catalog, connectors, isAdmin });
  const fromCatalog = choices.filter((choice) => choice.kind === "catalog");
  const fromWorkspace = choices.filter((choice) => choice.kind === "connector");

  const handleChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setValue(event.target.value);
  }, []);

  const add = useCallback(async () => {
    const choice = choices.find((item) => choiceValue(item) === value);
    if (choice === undefined) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      if (choice.kind === "catalog") {
        const { connectorId } = await getTrpc().catalog.add.mutate({
          key: choice.entry.key,
        });
        await getTrpc().connectors.assign.mutate({
          agentId,
          allowedTools: catalogAllowedTools(choice.entry),
          connectorId,
        });
      } else {
        await getTrpc().connectors.assign.mutate({
          agentId,
          connectorId: choice.connector.id,
        });
      }
      setValue("");
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [agentId, choices, onAdded, value]);

  if (choices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every app in the catalogue and in this workspace is already added.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">Add an app</p>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="App to add"
          onChange={handleChange}
          value={value}
        >
          <NativeSelectOption value="">Choose an app</NativeSelectOption>
          <ChoiceGroup choices={fromCatalog} label="From the catalogue" />
          <ChoiceGroup
            choices={fromWorkspace}
            label="Already in this workspace"
          />
        </NativeSelect>
        <Button disabled={value === "" || pending} onClick={add}>
          Add app
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ChoiceGroup({
  choices,
  label,
}: {
  choices: AddChoice[];
  label: string;
}) {
  if (choices.length === 0) {
    return null;
  }
  return (
    <NativeSelectOptGroup label={label}>
      {choices.map((choice) => (
        <NativeSelectOption
          disabled={choice.disabled}
          key={choiceValue(choice)}
          value={choiceValue(choice)}
        >
          {choice.label}
        </NativeSelectOption>
      ))}
    </NativeSelectOptGroup>
  );
}
