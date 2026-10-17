import { type ChangeEvent, useCallback } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  addRule,
  changeRule,
  MAX_RULES,
  type RuleDraft,
  removeRule,
} from "./secret-model.ts";

type RuleField = Exclude<keyof RuleDraft, "id">;

function RuleInput({
  helper,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  helper?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        autoComplete="off"
        id={id}
        onChange={handleChange}
        placeholder={placeholder}
        value={value}
      />
      {helper === undefined ? null : (
        <p className="text-muted-foreground text-xs">{helper}</p>
      )}
    </div>
  );
}

function RuleRow({
  canRemove,
  onChange,
  onRemove,
  rule,
}: {
  canRemove: boolean;
  onChange: (id: string, field: RuleField, value: string) => void;
  onRemove: (id: string) => void;
  rule: RuleDraft;
}) {
  const changeHost = useCallback(
    (value: string) => onChange(rule.id, "host", value),
    [onChange, rule.id]
  );
  const changeHeader = useCallback(
    (value: string) => onChange(rule.id, "header", value),
    [onChange, rule.id]
  );
  const changeTemplate = useCallback(
    (value: string) => onChange(rule.id, "template", value),
    [onChange, rule.id]
  );
  const remove = useCallback(() => onRemove(rule.id), [onRemove, rule.id]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <RuleInput
          id={`${rule.id}-host`}
          label="Host"
          onChange={changeHost}
          placeholder="api.openai.com"
          value={rule.host}
        />
        <RuleInput
          id={`${rule.id}-header`}
          label="Header"
          onChange={changeHeader}
          placeholder="Authorization"
          value={rule.header}
        />
      </div>
      <RuleInput
        helper="{value} is replaced by the secret."
        id={`${rule.id}-template`}
        label="Template"
        onChange={changeTemplate}
        placeholder="Bearer {value}"
        value={rule.template}
      />
      {canRemove ? (
        <Button
          className="self-end"
          onClick={remove}
          size="sm"
          type="button"
          variant="outline"
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
}

export function RulesEditor({
  onChange,
  rules,
}: {
  onChange: (rules: RuleDraft[]) => void;
  rules: RuleDraft[];
}) {
  const handleFieldChange = useCallback(
    (id: string, field: RuleField, value: string) =>
      onChange(changeRule(rules, id, field, value)),
    [onChange, rules]
  );
  const handleRemove = useCallback(
    (id: string) => onChange(removeRule(rules, id)),
    [onChange, rules]
  );
  const handleAdd = useCallback(
    () => onChange(addRule(rules)),
    [onChange, rules]
  );

  return (
    <div className="flex flex-col gap-3">
      {rules.map((rule) => (
        <RuleRow
          canRemove={rules.length > 1}
          key={rule.id}
          onChange={handleFieldChange}
          onRemove={handleRemove}
          rule={rule}
        />
      ))}
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          A request to a host is sent with the header. Up to {MAX_RULES} rules.
        </p>
        <Button
          disabled={rules.length >= MAX_RULES}
          onClick={handleAdd}
          size="sm"
          type="button"
          variant="outline"
        >
          Add rule
        </Button>
      </div>
    </div>
  );
}
