import {
  A2A_INBOUND_POLICIES,
  A2A_OUTBOUND_POLICIES,
  A2A_TOOL_POLICIES,
  type A2aInboundPolicy,
  type A2aOutboundPolicy,
  type A2aToolPolicy,
} from "@repo/db/shared";
import { type ChangeEvent, useCallback, useState } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  INBOUND_WORDS,
  isEnded,
  OUTBOUND_WORDS,
  type PolicySettings,
  TOOL_WORDS,
  wideningWarning,
  widens,
} from "./connections-logic.ts";

const HOURLY_MIN = 1;
const HOURLY_MAX = 10_000;
const WHOLE_NUMBER = /^\d+$/;

const INBOUND_LABELS: Record<A2aInboundPolicy, string> = {
  approve: "Ask first",
  auto: "Start a run at once",
  off: "Off",
};
const TOOL_LABELS: Record<A2aToolPolicy, string> = {
  agent_rules: "Use the agent's rules",
  ask: "Ask for each tool call",
};
const OUTBOUND_LABELS: Record<A2aOutboundPolicy, string> = {
  approve: "Ask first",
  auto: "Send at once",
  off: "Off",
};

/** The picks a person can make with the radio groups. The hourly limit is typed. */
type RadioPicks = Partial<
  Pick<PolicySettings, "inboundPolicy" | "outboundPolicy" | "toolPolicy">
>;

interface ChoiceOption {
  description: string;
  disabled: boolean;
  label: string;
  value: string;
}

const currentSettings = (
  connection: RouterOutputs["a2a"]["get"]
): PolicySettings => ({
  hourlyLimit: connection.hourlyLimit,
  inboundPolicy: connection.inboundPolicy,
  outboundPolicy: connection.outboundPolicy,
  toolPolicy: connection.toolPolicy,
});

/** The whole number the field holds, or null when it is not one from 1 to 10000. */
const parseHourly = (text: string): number | null => {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= HOURLY_MIN && value <= HOURLY_MAX ? value : null;
};

/** Only the fields that differ from the current settings. */
const changeFrom = (
  current: PolicySettings,
  picks: RadioPicks,
  hourly: number | null
): Partial<PolicySettings> => {
  const change: Partial<PolicySettings> = {};
  if (
    picks.inboundPolicy !== undefined &&
    picks.inboundPolicy !== current.inboundPolicy
  ) {
    change.inboundPolicy = picks.inboundPolicy;
  }
  if (
    picks.outboundPolicy !== undefined &&
    picks.outboundPolicy !== current.outboundPolicy
  ) {
    change.outboundPolicy = picks.outboundPolicy;
  }
  if (
    picks.toolPolicy !== undefined &&
    picks.toolPolicy !== current.toolPolicy
  ) {
    change.toolPolicy = picks.toolPolicy;
  }
  if (hourly !== null && hourly !== current.hourlyLimit) {
    change.hourlyLimit = hourly;
  }
  return change;
};

const choose = <T extends string>(
  options: readonly T[],
  value: string
): T | undefined => options.find((option) => option === value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function PolicyChoice({
  id,
  legend,
  onChange,
  options,
  value,
}: {
  id: string;
  legend: string;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  value: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium text-foreground text-sm">
        {legend}
      </legend>
      <RadioGroup onValueChange={onChange} value={value}>
        {options.map((option) => (
          <div className="flex items-start gap-3" key={option.value}>
            <RadioGroupItem
              className="mt-1"
              disabled={option.disabled}
              id={`${id}-${option.value}`}
              value={option.value}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${id}-${option.value}`}>{option.label}</Label>
              <p className="text-muted-foreground text-sm">
                {option.description}
              </p>
            </div>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

export function PoliciesPanel({
  connection,
  manageReason,
  onChanged,
}: {
  connection: RouterOutputs["a2a"]["get"];
  manageReason: string | null;
  onChanged: () => void;
}) {
  const [picks, setPicks] = useState<RadioPicks>({});
  const [hourlyText, setHourlyText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = currentSettings(connection);
  const ended = isEnded(connection.status);
  const shownHourly = hourlyText ?? String(current.hourlyLimit);
  const hourly = parseHourly(shownHourly);
  const change = changeFrom(current, picks, hourly);
  const hasChange = Object.keys(change).length > 0;
  const widening = widens(current, change);
  const warning = wideningWarning(change);
  const saveBlocked =
    saving || hourly === null || (manageReason !== null && widening);

  const connectionId = connection.id;
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await getTrpc().a2a.setPolicies.mutate({ connectionId, ...change });
      setPicks({});
      setHourlyText(null);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [change, connectionId, onChanged]);

  const handleInboundChange = useCallback((value: string) => {
    const next = choose(A2A_INBOUND_POLICIES, value);
    if (next !== undefined) {
      setPicks((previous) => ({ ...previous, inboundPolicy: next }));
    }
  }, []);

  const handleOutboundChange = useCallback((value: string) => {
    const next = choose(A2A_OUTBOUND_POLICIES, value);
    if (next !== undefined) {
      setPicks((previous) => ({ ...previous, outboundPolicy: next }));
    }
  }, []);

  const handleToolChange = useCallback((value: string) => {
    const next = choose(A2A_TOOL_POLICIES, value);
    if (next !== undefined) {
      setPicks((previous) => ({ ...previous, toolPolicy: next }));
    }
  }, []);

  const handleHourlyChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setHourlyText(event.target.value);
    },
    []
  );

  const optionsFor = <T extends string>(
    values: readonly T[],
    labels: Record<T, string>,
    words: Record<T, string>,
    widensWith: (value: T) => boolean
  ): ChoiceOption[] =>
    values.map((value) => ({
      description: words[value],
      disabled: ended || (manageReason !== null && widensWith(value)),
      label: labels[value],
      value,
    }));

  const inboundOptions = optionsFor(
    A2A_INBOUND_POLICIES,
    INBOUND_LABELS,
    INBOUND_WORDS,
    (value) => widens(current, { inboundPolicy: value })
  );
  const toolOptions = optionsFor(
    A2A_TOOL_POLICIES,
    TOOL_LABELS,
    TOOL_WORDS,
    (value) => widens(current, { toolPolicy: value })
  );
  const outboundOptions = optionsFor(
    A2A_OUTBOUND_POLICIES,
    OUTBOUND_LABELS,
    OUTBOUND_WORDS,
    (value) => widens(current, { outboundPolicy: value })
  );

  const showIncoming = connection.peerKind !== "a2a_outbound";
  const showOutbound = connection.peerKind !== "a2a_inbound";

  return (
    <div className="flex flex-col gap-6">
      {showIncoming ? (
        <PolicyChoice
          id="inbound"
          legend="Messages this peer sends us"
          onChange={handleInboundChange}
          options={inboundOptions}
          value={picks.inboundPolicy ?? current.inboundPolicy}
        />
      ) : null}
      {showIncoming ? (
        <PolicyChoice
          id="tool"
          legend="Tools in runs this peer starts"
          onChange={handleToolChange}
          options={toolOptions}
          value={picks.toolPolicy ?? current.toolPolicy}
        />
      ) : null}
      {showOutbound ? (
        <PolicyChoice
          id="outbound"
          legend="Messages our agent sends this peer"
          onChange={handleOutboundChange}
          options={outboundOptions}
          value={picks.outboundPolicy ?? current.outboundPolicy}
        />
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="policy-hourly">Hourly limit</Label>
        <Input
          disabled={ended}
          id="policy-hourly"
          max={HOURLY_MAX}
          min={HOURLY_MIN}
          onChange={handleHourlyChange}
          step={1}
          type="number"
          value={shownHourly}
        />
        <p className="text-muted-foreground text-sm">
          Tasks per hour on this connection, both directions. From {HOURLY_MIN}{" "}
          to {HOURLY_MAX}.
        </p>
        {hourly === null ? (
          <p className="text-destructive text-sm">
            Enter a whole number from {HOURLY_MIN} to {HOURLY_MAX}.
          </p>
        ) : null}
      </div>
      {hasChange && !ended ? (
        <div className="flex flex-col gap-3">
          {warning === null ? null : (
            <Alert>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button disabled={saveBlocked} onClick={save}>
              {warning === null ? "Save" : "Allow this"}
            </Button>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {manageReason === null ? null : (
        <p className="text-muted-foreground text-sm">{manageReason}</p>
      )}
      {ended ? (
        <p className="text-muted-foreground text-sm">
          This connection has ended.
        </p>
      ) : null}
    </div>
  );
}
