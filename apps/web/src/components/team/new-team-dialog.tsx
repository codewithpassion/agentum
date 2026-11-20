import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { errorMessage } from "#/lib/error-message";
import {
  type NewTeamInput,
  nameError,
  type TeamAgent,
  type TeamPerson,
} from "./team-logic.ts";

interface NewTeamFormProps {
  agents: readonly TeamAgent[];
  onCancel: () => void;
  onCreate: (input: NewTeamInput) => Promise<void>;
  people: readonly TeamPerson[] | null;
  youId: string | null | undefined;
}

function CheckRow({
  checked,
  disabled,
  id,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  id: string;
  label: string;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const inputId = `new-team-member-${id}`;
  const change = useCallback(
    (next: boolean | "indeterminate") => onToggle(id, next === true),
    [id, onToggle]
  );
  return (
    <li className="flex pointer-coarse:min-h-10 items-center gap-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={inputId}
        onCheckedChange={change}
      />
      <Label htmlFor={inputId}>{label}</Label>
    </li>
  );
}

const toggled = (
  current: ReadonlySet<string>,
  id: string,
  checked: boolean
): Set<string> => {
  const next = new Set(current);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
};

export function NewTeamForm({
  agents,
  onCancel,
  onCreate,
  people,
  youId,
}: NewTeamFormProps) {
  const [name, setName] = useState("");
  const [agentIds, setAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [personIds, setPersonIds] = useState<ReadonlySet<string>>(
    () => new Set(youId ? [youId] : [])
  );
  const [leadId, setLeadId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const toggleAgent = useCallback(
    (id: string, checked: boolean) =>
      setAgentIds((current) => toggled(current, id, checked)),
    []
  );
  const togglePerson = useCallback(
    (id: string, checked: boolean) =>
      setPersonIds((current) => toggled(current, id, checked)),
    []
  );
  const changeLead = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setLeadId(event.target.value),
    []
  );

  // A lead that was unticked in the member list no longer counts.
  const chosenAgents = agents.filter((agent) => agentIds.has(agent.id));
  const lead = chosenAgents.some((agent) => agent.id === leadId) ? leadId : "";

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const problem = nameError(name);
      if (problem !== null) {
        setError(problem);
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await onCreate({
          agentIds: [...agentIds],
          leadAgentId: lead === "" ? null : lead,
          name,
          personIds: [...personIds],
        });
      } catch (caught) {
        setError(errorMessage(caught));
        setSaving(false);
      }
    },
    [agentIds, lead, name, onCreate, personIds]
  );

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor="new-team-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          id="new-team-name"
          onChange={changeName}
          placeholder="Sales"
          required
          value={name}
        />
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="font-medium text-sm">Agents</legend>
        {agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            There are no agents yet. Add them to the team later.
          </p>
        ) : (
          <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
            {agents.map((agent) => (
              <CheckRow
                checked={agentIds.has(agent.id)}
                disabled={saving}
                id={agent.id}
                key={agent.id}
                label={agent.name}
                onToggle={toggleAgent}
              />
            ))}
          </ul>
        )}
      </fieldset>
      <Field>
        <FieldLabel htmlFor="new-team-lead">Lead</FieldLabel>
        <NativeSelect
          disabled={saving || chosenAgents.length === 0}
          id="new-team-lead"
          onChange={changeLead}
          value={lead}
        >
          <NativeSelectOption value="">No lead</NativeSelectOption>
          {chosenAgents.map((agent) => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          Choose the lead from the agents you ticked. You can change it later.
        </FieldDescription>
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="font-medium text-sm">People</legend>
        {people === null ? (
          <p className="text-muted-foreground text-sm">
            The list of people could not be loaded. Add them to the team later.
          </p>
        ) : (
          <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
            {people.map((person) => (
              <CheckRow
                checked={personIds.has(person.userId)}
                disabled={saving}
                id={person.userId}
                key={person.userId}
                label={
                  person.userId === youId ? `${person.name} (you)` : person.name
                }
                onToggle={togglePerson}
              />
            ))}
          </ul>
        )}
      </fieldset>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          disabled={saving}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={saving} type="submit">
          {saving ? "Creating" : "Create team"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The New team dialog: a name, the agents and people to put in, and which agent
 * leads. `onCreate` makes the team and rejects with an Error to show in the dialog.
 */
export function NewTeamDialog({
  agents,
  onCreate,
  onOpenChange,
  open,
  people,
  youId,
}: {
  agents: readonly TeamAgent[];
  onCreate: (input: NewTeamInput) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  people: readonly TeamPerson[] | null;
  youId: string | null | undefined;
}) {
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
          <DialogDescription>
            A team is agents and people who work in one room, with a lead who
            hands out the work.
          </DialogDescription>
        </DialogHeader>
        <NewTeamForm
          agents={agents}
          onCancel={cancel}
          onCreate={onCreate}
          people={people}
          youId={youId}
        />
      </DialogContent>
    </Dialog>
  );
}
