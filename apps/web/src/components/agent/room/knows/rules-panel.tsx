import type { MemoryRules, RememberRules } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import {
  addRule,
  LEARN_LEVEL_OPTIONS,
  neverRows,
  type RuleRow,
  removeRule,
} from "./rules-logic.ts";

function RuleItem({
  disabled,
  onRemove,
  text,
}: {
  disabled: boolean;
  onRemove: (text: string) => void;
  text: string;
}) {
  const remove = useCallback(() => onRemove(text), [onRemove, text]);
  return (
    <li className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="min-w-0 break-words">{text}</span>
      <Button
        disabled={disabled}
        onClick={remove}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove
      </Button>
    </li>
  );
}

function LockedRule({ text }: { text: string }) {
  return (
    <li
      className="flex items-center justify-between gap-2 py-1 text-sm"
      data-testid="locked-rule"
    >
      <span className="min-w-0 break-words">{text}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        workspace rule
      </span>
    </li>
  );
}

function RuleList({
  addLabel,
  disabled,
  onAdd,
  onRemove,
  rows,
  title,
}: {
  addLabel: string;
  disabled: boolean;
  /** Returns true when the text was added, so the draft can clear. */
  onAdd: (text: string) => boolean;
  onRemove: (text: string) => void;
  rows: readonly RuleRow[];
  title: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const changeDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (onAdd(draft)) {
        setDraft("");
      }
    },
    [draft, onAdd]
  );
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">{title}</h3>
      <ul className="flex flex-col">
        {rows.map((row) =>
          row.locked ? (
            <LockedRule key={row.text} text={row.text} />
          ) : (
            <RuleItem
              disabled={disabled}
              key={row.text}
              onRemove={onRemove}
              text={row.text}
            />
          )
        )}
      </ul>
      <form className="flex gap-2" onSubmit={submit}>
        <Label className="sr-only" htmlFor={inputId}>
          {addLabel}
        </Label>
        <Input
          disabled={disabled}
          id={inputId}
          onChange={changeDraft}
          value={draft}
        />
        <Button disabled={disabled} type="submit" variant="outline">
          Add
        </Button>
      </form>
    </section>
  );
}

export function RulesPanel(props: {
  canChange: boolean;
  rules: MemoryRules;
  saving: boolean;
  onChange: (next: RememberRules) => void;
}) {
  const { canChange, onChange, rules, saving } = props;
  const { agent, workspaceNever } = rules;
  const disabled = saving || !canChange;
  const never = neverRows(workspaceNever, agent.never);

  const addRemember = useCallback(
    (text: string): boolean => {
      const remember = addRule(agent.remember, text);
      if (remember === null) {
        return false;
      }
      onChange({ ...agent, remember });
      return true;
    },
    [agent, onChange]
  );
  const removeRemember = useCallback(
    (text: string) =>
      onChange({ ...agent, remember: removeRule(agent.remember, text) }),
    [agent, onChange]
  );
  const addNever = useCallback(
    (text: string): boolean => {
      const next = addRule(agent.never, text);
      if (next === null) {
        return false;
      }
      onChange({ ...agent, never: next });
      return true;
    },
    [agent, onChange]
  );
  const removeNever = useCallback(
    (text: string) =>
      onChange({ ...agent, never: removeRule(agent.never, text) }),
    [agent, onChange]
  );
  const changeLearnLevel = useCallback(
    (value: string) => {
      const option = LEARN_LEVEL_OPTIONS.find(
        (candidate) => candidate.value === value
      );
      if (option === undefined) {
        return;
      }
      onChange({ ...agent, learnLevel: option.value });
    },
    [agent, onChange]
  );
  const changeShare = useCallback(
    (checked: boolean) => onChange({ ...agent, shareWithTeam: checked }),
    [agent, onChange]
  );

  const rememberRows: RuleRow[] = agent.remember.map((text) => ({
    locked: false,
    text,
  }));

  return (
    <div className="flex flex-col gap-6">
      {canChange ? null : (
        <p className="text-muted-foreground text-sm">
          Only the owner or an admin can change these.
        </p>
      )}
      <RuleList
        addLabel="Add to Remember"
        disabled={disabled}
        onAdd={addRemember}
        onRemove={removeRemember}
        rows={rememberRows}
        title="Remember"
      />
      <RuleList
        addLabel="Add to Never remember"
        disabled={disabled}
        onAdd={addNever}
        onRemove={removeNever}
        rows={never}
        title="Never remember"
      />
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">How it learns</h3>
        <RadioGroup
          disabled={disabled}
          onValueChange={changeLearnLevel}
          value={agent.learnLevel}
        >
          {LEARN_LEVEL_OPTIONS.map((option) => (
            <Label
              className="flex items-start gap-3 font-normal"
              key={option.value}
            >
              <RadioGroupItem className="mt-0.5" value={option.value} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-muted-foreground text-xs">
                  {option.hint}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-medium text-sm">Shares with team</h3>
          <Switch
            aria-label="Shares with team"
            checked={agent.shareWithTeam}
            disabled={disabled}
            onCheckedChange={changeShare}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          The team dream may lift this agent's notes into team memory.
        </p>
      </section>
    </div>
  );
}
