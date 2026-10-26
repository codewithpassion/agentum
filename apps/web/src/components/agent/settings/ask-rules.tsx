import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AssignmentRecord,
  ConnectorRecord,
  RouterOutputs,
} from "#/integrations/trpc/types";
import { toolKeyOfInput, toolKeySuggestions } from "./ask-rules-logic.ts";

type RuleRecord = RouterOutputs["requests"]["rules"]["list"][number];

interface AskData {
  assignments: AssignmentRecord[];
  connectors: ConnectorRecord[];
  rules: RuleRecord[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const loadAsk = async (agentId: string): Promise<AskData> => {
  const [rules, connectors, assignments] = await Promise.all([
    getTrpc().requests.rules.list.query({ agentId }),
    getTrpc().connectors.list.query(),
    getTrpc().connectors.assignments.query({ agentId }),
  ]);
  return { assignments, connectors, rules };
};

interface RuleRowProps {
  disabled: boolean;
  onRemove: (toolKey: string) => void;
  toolKey: string;
}

function RuleRow({ disabled, onRemove, toolKey }: RuleRowProps) {
  const remove = useCallback(() => onRemove(toolKey), [onRemove, toolKey]);
  return (
    <li className="flex items-center justify-between gap-2">
      <code className="text-sm">{toolKey}</code>
      <Button
        aria-label={`Remove ${toolKey}`}
        disabled={disabled}
        onClick={remove}
        size="sm"
        variant="outline"
      >
        Remove
      </Button>
    </li>
  );
}

export function AskRules({ agentId }: { agentId: string }) {
  const [data, setData] = useState<AskData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    loadAsk(agentId)
      .then((loaded) => {
        if (active) {
          setData(loaded);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  const change = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        setData(await loadAsk(agentId));
        setError(undefined);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [agentId]
  );

  const remove = useCallback(
    async (toolKey: string) => {
      await change(() =>
        getTrpc().requests.rules.remove.mutate({ agentId, toolKey })
      );
    },
    [agentId, change]
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    []
  );

  const key = toolKeyOfInput(value);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (key === null) {
        return;
      }
      const added = await change(() =>
        getTrpc().requests.rules.set.mutate({
          agentId,
          mode: "ask",
          toolKey: key,
        })
      );
      if (added) {
        setValue("");
      }
    },
    [agentId, change, key]
  );

  const asking =
    data === undefined ? [] : data.rules.filter((rule) => rule.mode === "ask");
  const suggestions =
    data === undefined
      ? []
      : toolKeySuggestions({
          connectors: data.assignments.flatMap(({ connectorId }) =>
            data.connectors.filter((connector) => connector.id === connectorId)
          ),
          taken: asking.map((rule) => rule.toolKey),
        });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-lg">Ask me before it...</h2>
        <p className="text-muted-foreground text-sm">
          The agent stops and asks you before it uses these tools. Everything
          else runs without asking.
        </p>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {data === undefined && error === undefined ? (
        <p className="text-muted-foreground text-sm">Loading rules.</p>
      ) : null}
      {data !== undefined && asking.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No tool needs asking yet.
        </p>
      ) : null}
      {asking.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {asking.map((rule) => (
            <RuleRow
              disabled={busy}
              key={rule.toolKey}
              onRemove={remove}
              toolKey={rule.toolKey}
            />
          ))}
        </ul>
      ) : null}
      <form className="flex items-end gap-2" onSubmit={submit}>
        <div className="flex w-full max-w-xs flex-col gap-1.5">
          <Label htmlFor="ask-tool-key">Tool key</Label>
          <Input
            autoComplete="off"
            id="ask-tool-key"
            list="ask-tool-key-options"
            onChange={onChange}
            placeholder="bash or connector/tool"
            value={value}
          />
          <datalist id="ask-tool-key-options">
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
        <Button disabled={busy || key === null} type="submit">
          Add
        </Button>
      </form>
    </section>
  );
}
