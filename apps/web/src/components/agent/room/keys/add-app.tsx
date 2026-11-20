import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  AppPicker,
  type AppPickerGroup,
} from "#/components/connectors/app-picker";
import { getTrpc } from "#/integrations/trpc/client";
import {
  type AddChoice,
  addChoices,
  catalogAllowedTools,
  choiceValue,
} from "./add-app-logic.ts";

type AddAppProps = Parameters<typeof addChoices>[0] & {
  agentId: string;
  /** Turns the picker and the add button off for a member who cannot change the agent. */
  disabled: boolean;
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
  disabled,
  isAdmin,
  onAdded,
}: AddAppProps) {
  const choices = useMemo(
    () => addChoices({ assignedIds, catalog, connectors, isAdmin }),
    [assignedIds, catalog, connectors, isAdmin]
  );
  const groups = useMemo(() => pickerGroups(choices), [choices]);

  const add = useCallback(
    async (value: string) => {
      const choice = choices.find((item) => choiceValue(item) === value);
      if (choice === undefined) {
        return;
      }
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
          allowedTools: choice.allowedTools,
          connectorId: choice.connector.id,
        });
      }
      onAdded();
    },
    [agentId, choices, onAdded]
  );

  const connectorsLink = isAdmin ? (
    <>
      {" "}
      Add one that is not listed on the{" "}
      <Link to="/settings/connectors">Apps page</Link>.
    </>
  ) : null;

  if (choices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        There is no other app to add.{connectorsLink}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">Add an app</p>
      <AppPicker disabled={disabled} groups={groups} onAdd={add} />
      {disabled ? (
        <p className="text-muted-foreground text-xs">
          Only the agent's owners and admins can change its apps.
        </p>
      ) : null}
      {connectorsLink === null ? null : (
        <p className="text-muted-foreground text-xs">{connectorsLink}</p>
      )}
    </div>
  );
}

const pickerGroups = (choices: AddChoice[]): AppPickerGroup[] => {
  const group = (label: string, kind: AddChoice["kind"]): AppPickerGroup => ({
    label,
    options: choices
      .filter((choice) => choice.kind === kind)
      .map((choice) => ({
        disabled: choice.disabled,
        label: choice.label,
        value: choiceValue(choice),
      })),
  });
  return [
    group("From the catalogue", "catalog"),
    group("Already in this workspace", "connector"),
  ];
};
