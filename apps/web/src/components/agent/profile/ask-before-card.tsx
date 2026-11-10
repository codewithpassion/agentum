import { ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import {
  ASK_LEVEL_OPTIONS,
  type AskBeforeAction,
  type AskGroup,
  type AskLevelValue,
  askSummary,
  groupActions,
  isPresetLevel,
} from "./ask-groups.ts";
import { Disclosure } from "./disclosure.tsx";
import { MailAllowedList } from "./mail-allowed-list.tsx";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function AskBeforeRow({
  disabled,
  item,
  onToggle,
}: {
  disabled: boolean;
  item: AskBeforeAction;
  onToggle: (action: string, ask: boolean) => void;
}) {
  const toggle = useCallback(
    (next: boolean) => onToggle(item.action, next),
    [item.action, onToggle]
  );
  const askAgain = useCallback(() => toggle(true), [toggle]);
  return (
    <li className="flex flex-col gap-1 border-border border-t border-dashed py-2.5 first:border-t-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-sm">{item.label}</span>
        <Switch
          aria-label={`Ask before ${item.label}`}
          checked={item.ask}
          disabled={disabled}
          onCheckedChange={toggle}
        />
      </div>
      {item.ask && item.allowed !== undefined && item.allowed.length > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span>You chose Always allow for {item.allowed.join(", ")}.</span>
          <Button
            disabled={disabled}
            onClick={askAgain}
            size="sm"
            type="button"
            variant="outline"
          >
            Ask again
          </Button>
        </p>
      ) : null}
    </li>
  );
}

function AskGroupSection({
  disabled,
  group,
  onGroup,
  onToggle,
}: {
  disabled: boolean;
  group: AskGroup;
  onGroup: (group: AskGroup, ask: boolean) => void;
  onToggle: (action: string, ask: boolean) => void;
}) {
  const toggleGroup = useCallback(
    (next: boolean) => onGroup(group, next),
    [group, onGroup]
  );
  return (
    <Collapsible className="border-border border-t border-dashed first:border-t-0">
      <div className="flex items-center justify-between gap-3 py-2.5">
        <CollapsibleTrigger className="group flex min-w-0 items-center gap-1.5 text-left text-sm">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          />
          <span className="min-w-0 font-medium">{group.name}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {askSummary(group)}
          </span>
        </CollapsibleTrigger>
        <Switch
          aria-label={`Ask before every ${group.name} action`}
          checked={group.askCount === group.actions.length}
          disabled={disabled}
          onCheckedChange={toggleGroup}
        />
      </div>
      <CollapsibleContent>
        {group.covers.map((text) => (
          <p className="pb-1 pl-5.5 text-muted-foreground text-xs" key={text}>
            {text}
          </p>
        ))}
        <ul className="pl-5.5">
          {group.actions.map((item) => (
            <AskBeforeRow
              disabled={disabled}
              item={item}
              key={item.action}
              onToggle={onToggle}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LevelPicker({
  disabled,
  level,
  onChange,
}: {
  disabled: boolean;
  level: string;
  onChange: (level: AskLevelValue) => void;
}) {
  const change = useCallback(
    (value: string) => {
      if (isPresetLevel(value)) {
        onChange(value);
      }
    },
    [onChange]
  );
  return (
    <RadioGroup
      aria-label="Ask level"
      disabled={disabled}
      onValueChange={change}
      value={isPresetLevel(level) ? level : ""}
    >
      {ASK_LEVEL_OPTIONS.map((option) => (
        <label
          className="flex items-start gap-2.5 text-sm"
          htmlFor={`ask-level-${option.value}`}
          key={option.value}
        >
          <RadioGroupItem
            className="mt-0.5"
            id={`ask-level-${option.value}`}
            value={option.value}
          />
          <span className="flex min-w-0 flex-col">
            <span>{option.label}</span>
            <span className="text-muted-foreground text-xs">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

/** The fixed row for mail to people outside the workspace. The badge never wraps. */
export function OutsideEmailRow() {
  return (
    <div className="flex items-center justify-between gap-3 border-border border-t border-dashed py-2.5">
      <span className="min-w-0 text-sm">
        Emails someone outside the workspace: always asks
      </span>
      <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">
        Always
      </span>
    </div>
  );
}

function AskBeforeBody({
  agentId,
  initialActions,
  initialLevel,
  mailAllowed,
  archived,
  onEditSettings,
}: {
  agentId: string;
  archived: boolean;
  initialActions: AskBeforeAction[];
  initialLevel: string;
  mailAllowed: string[];
  onEditSettings: () => void;
}) {
  const [actions, setActions] = useState(initialActions);
  const [level, setLevel] = useState(initialLevel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = useCallback(
    async (write: () => Promise<unknown>) => {
      setSaving(true);
      setError(undefined);
      try {
        await write();
      } catch (cause) {
        setError(errorMessage(cause));
      }
      try {
        const trpc = getTrpc();
        const [nextActions, nextLevel] = await Promise.all([
          trpc.agentProfile.askBefore.query({ agentId }),
          trpc.agentProfile.askLevel.query({ agentId }),
        ]);
        setActions(nextActions);
        setLevel(nextLevel);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [agentId]
  );

  const changeLevel = useCallback(
    (next: AskLevelValue) =>
      save(() =>
        getTrpc().agentProfile.setAskLevel.mutate({ agentId, level: next })
      ),
    [agentId, save]
  );
  const toggle = useCallback(
    (action: string, ask: boolean) =>
      save(() =>
        getTrpc().agentProfile.setAskBefore.mutate({ action, agentId, ask })
      ),
    [agentId, save]
  );
  const toggleGroup = useCallback(
    (group: AskGroup, ask: boolean) =>
      save(() =>
        Promise.all(
          group.actions
            .filter((item) => item.ask !== ask)
            .map((item) =>
              getTrpc().agentProfile.setAskBefore.mutate({
                action: item.action,
                agentId,
                ask,
              })
            )
        )
      ),
    [agentId, save]
  );

  const overrides = actions.filter((item) => item.overridden).length;
  const groups = groupActions(actions);
  return (
    <>
      <section
        aria-label="Ask me before it"
        className="rounded-lg border border-border bg-card px-4 py-3"
      >
        <h2 className="font-semibold text-sm">Ask me before it…</h2>
        <p className="mb-2 text-muted-foreground text-xs">
          The agent stops and asks you before it does what its level covers, and
          tools it gets later follow the level.
        </p>
        <LevelPicker disabled={saving} level={level} onChange={changeLevel} />
        <p className="mt-2 text-muted-foreground text-xs">
          {level === "custom"
            ? "This agent uses its own switches. Pick a level to start from one, and your switches stay as they are."
            : `${overrides} ${overrides === 1 ? "switch is" : "switches are"} set apart from this level.`}
        </p>
        {error === undefined ? null : (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </section>
      <section
        aria-label="Advanced"
        className="rounded-lg border border-border bg-card px-4"
      >
        <Disclosure
          defaultOpen={archived}
          summary="Model, environment, network, turn limit, ask overrides"
          title="Advanced"
        >
          <div className="flex flex-col gap-3 pb-3">
            <div>
              <Button
                onClick={onEditSettings}
                size="sm"
                type="button"
                variant="outline"
              >
                Model, environment, network, turn limit
              </Button>
            </div>
            <div>
              <h3 className="font-semibold text-sm">Ask overrides</h3>
              <p className="text-muted-foreground text-xs">
                Switch single actions on or off, apart from the level.
              </p>
              {groups.map((group) => (
                <AskGroupSection
                  disabled={saving}
                  group={group}
                  key={group.name}
                  onGroup={toggleGroup}
                  onToggle={toggle}
                />
              ))}
              <OutsideEmailRow />
              {mailAllowed.length === 0 ? null : (
                <MailAllowedList addresses={mailAllowed} agentId={agentId} />
              )}
            </div>
          </div>
        </Disclosure>
      </section>
    </>
  );
}

/**
 * The ask level, then an Advanced card that holds the ask overrides and the
 * way into the model and runtime settings. They share the ask state.
 */
export function AskBeforeCard({
  actions,
  agentId,
  archived,
  level,
  mailAllowed,
  onEditSettings,
}: {
  agentId: string;
  actions: AskBeforeAction[];
  /** Archived agents start Advanced open, because their disabled page cannot open it. */
  archived: boolean;
  /** The agent's ask level: a preset, or custom for one with its own rules. */
  level: string;
  /** Bare email addresses the agent may always email without asking. */
  mailAllowed: string[];
  /** Opens the sheet with the model, environment, network and turn limit. */
  onEditSettings: () => void;
}) {
  return (
    <AskBeforeBody
      agentId={agentId}
      archived={archived}
      initialActions={actions}
      initialLevel={level}
      key={agentId}
      mailAllowed={mailAllowed}
      onEditSettings={onEditSettings}
    />
  );
}
