import { MODEL_PROVIDERS } from "@repo/db/shared";
import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { AllowedHostsField } from "#/components/secrets/allowed-hosts-field";
import { RulesEditor } from "#/components/secrets/rules-editor";
import {
  emptyRule,
  errorMessage,
  parseHosts,
  toRules,
} from "#/components/secrets/secret-model";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type { AssistantAgent, CardOutcome, PendingCard } from "./types";

import { useCardRecovery } from "./use-card-recovery";

type Client = ReturnType<typeof getTrpc>;
export interface CardApi {
  createSecret: (
    input: Parameters<Client["secrets"]["create"]["mutate"]>[0]
  ) => Promise<{ id: string }>;
  getGrants: (agentId: string) => Promise<string[]>;
  setGrants: (input: {
    agentId: string;
    secretIds: string[];
  }) => Promise<unknown>;
  setModelKey: (input: {
    apiKey: string;
    provider: "anthropic" | "openrouter";
  }) => Promise<unknown>;
}
const cardApi: CardApi = {
  createSecret: (input) => getTrpc().secrets.create.mutate(input),
  getGrants: (agentId) => getTrpc().secrets.grants.query({ agentId }),
  setGrants: (input) => getTrpc().secrets.setGrants.mutate(input),
  setModelKey: ({ apiKey, provider }) =>
    provider === "anthropic"
      ? getTrpc().managedKeys.set.mutate({ apiKey })
      : getTrpc().modelKeys.set.mutate({ apiKey, provider }),
};
const CAMEL_BOUNDARY = /([a-z])([A-Z])/g;
const argumentLabel = (key: string) =>
  key.replace(CAMEL_BOUNDARY, "$1 $2").replaceAll("_", " ").toLowerCase();

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const string = (value: unknown) => (typeof value === "string" ? value : "");

export function outcomeLine(
  outcome: CardOutcome,
  agents: AssistantAgent[] = []
): string {
  if ("run" in outcome) {
    return outcome.run ? "Ran tool" : "Didn't run";
  }
  if (!outcome.saved) {
    return outcome.reason === "cancelled" ? "Cancelled" : "Declined";
  }
  if ("provider" in outcome) {
    return `Saved ${outcome.provider} model key`;
  }
  const names = outcome.grantedTo.map(
    (id) => agents.find((agent) => agent.id === id)?.name ?? id
  );
  return `Saved secret ${outcome.name}${names.length ? `, granted to ${names.join(", ")}` : ""}`;
}

/** Keeps storage progress separately from outcome delivery, so retries cannot recreate a secret. */
export function AssistantCard({
  card,
  agents,
  onResolve,
  api = cardApi,
  disabled = false,
  recoveryKey,
}: {
  agents: AssistantAgent[];
  api?: CardApi;
  card: PendingCard;
  disabled?: boolean;
  recoveryKey?: string;
  onResolve: (outcome: CardOutcome) => Promise<void>;
}) {
  const id = useId();
  const { outcome: recovered, remember, forget } = useCardRecovery(recoveryKey);
  const [name, setName] = useState(string(card.arguments.name));
  const [mode, setMode] = useState<"env" | "proxy">(
    card.arguments.mode === "proxy" ? "proxy" : "env"
  );
  const [hosts, setHosts] = useState(strings(card.arguments.hosts).join(", "));
  const [grantTo, setGrantTo] = useState(() => {
    const refs = strings(card.arguments.grantTo);
    return agents
      .filter((agent) => refs.includes(agent.id) || refs.includes(agent.slug))
      .map((agent) => agent.id);
  });
  const [provider, setProvider] = useState<"anthropic" | "openrouter">(
    card.arguments.provider === "openrouter" ? "openrouter" : "anthropic"
  );
  const [rules, setRules] = useState(() => initialRules(card));
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<CardOutcome | null>(null);
  const progress = useRef<{
    secretId?: string;
    granted: Set<string>;
    outcome?: CardOutcome;
  }>({ granted: new Set() });
  const activeSubmission = useRef(new Set<string>());

  const deliver = useCallback(
    async (outcome: CardOutcome) => {
      progress.current.outcome = outcome;
      remember(outcome);
      await onResolve(outcome);
      forget();
      setSettled(outcome);
    },
    [onResolve, remember, forget]
  );
  const run = useCallback(async (operation: () => Promise<void>) => {
    if (activeSubmission.current.has("saving")) {
      return;
    }
    activeSubmission.current.add("saving");
    setSaving(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      activeSubmission.current.delete("saving");
      setSaving(false);
    }
  }, []);
  const save = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      run(async () => {
        const outcome = progress.current.outcome ?? recovered;
        if (outcome) {
          await deliver(outcome);
          return;
        }
        if (card.kind === "model_key") {
          await api.setModelKey({ apiKey: value, provider });
          setValue("");
          await deliver({ provider, saved: true });
          return;
        }
        const targets = grantTo;
        if (!progress.current.secretId) {
          const created = await api.createSecret(
            mode === "proxy"
              ? { mode, name, rules: toRules(rules), value }
              : { allowedHosts: parseHosts(hosts), mode, name, value }
          );
          progress.current.secretId = created.id;
          setValue("");
        }
        const { secretId } = progress.current;
        await Promise.all(
          targets.map(async (agentId) => {
            if (progress.current.granted.has(agentId)) {
              return;
            }
            const existing = await api.getGrants(agentId);
            await api.setGrants({
              agentId,
              secretIds: [...new Set([...existing, secretId])],
            });
            progress.current.granted.add(agentId);
          })
        );
        await deliver({
          grantedTo: targets,
          hosts:
            mode === "proxy"
              ? rules.map((rule) => rule.host.trim())
              : parseHosts(hosts),
          mode,
          name: name.trim(),
          saved: true,
          secretId,
        });
      });
    },
    [
      api,
      card.kind,
      deliver,
      grantTo,
      hosts,
      mode,
      name,
      provider,
      recovered,
      rules,
      run,
      value,
    ]
  );

  const onRun = useCallback(
    () =>
      run(() =>
        deliver(progress.current.outcome ?? recovered ?? { run: true })
      ),
    [run, deliver, recovered]
  );
  const onSkip = useCallback(
    () => run(() => deliver({ run: false })),
    [run, deliver]
  );
  const decline = useCallback(
    () =>
      run(() => {
        setValue("");
        return deliver({ reason: "declined", saved: false });
      }),
    [run, deliver]
  );
  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const changeGrants = useCallback((agentId: string, checked: boolean) => {
    setGrantTo((current) =>
      checked
        ? [...current, agentId]
        : current.filter((targetId) => targetId !== agentId)
    );
  }, []);
  const changeValue = useCallback(
    (event: FormEvent<HTMLInputElement>) => setValue(event.currentTarget.value),
    []
  );
  const changeMode = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setMode(event.target.value === "proxy" ? "proxy" : "env"),
    []
  );
  const changeProvider = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setProvider(
        event.target.value === "openrouter" ? "openrouter" : "anthropic"
      ),
    []
  );

  if (settled) {
    return (
      <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
        {outcomeLine(settled, agents)}
      </p>
    );
  }
  const stored = Boolean(
    progress.current.secretId || progress.current.outcome || recovered
  );
  return (
    <form className="rounded-xl border bg-card p-4 shadow-sm" onSubmit={save}>
      <fieldset
        className="flex min-w-0 flex-col gap-2.5"
        disabled={saving || disabled}
      >
        <legend className="mb-3 font-medium">{card.title}</legend>
        {card.kind === "confirm" ? (
          <ConfirmFields
            agents={agents}
            answered={Boolean(progress.current.outcome || recovered)}
            card={card}
            onRun={onRun}
            onSkip={onSkip}
          />
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {string(card.arguments.reason)}
            </p>
            {card.kind === "model_key" ? (
              <>
                <Label htmlFor={`${id}-provider`}>Provider</Label>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  disabled={stored}
                  id={`${id}-provider`}
                  onChange={changeProvider}
                  value={provider}
                >
                  {MODEL_PROVIDERS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <SecretFields
                {...{
                  agents,
                  changeGrants,
                  changeMode,
                  changeName,
                  grantTo,
                  hosts,
                  id,
                  mode,
                  name,
                  rules,
                  setHosts,
                  setRules,
                  stored,
                }}
              />
            )}
            {stored ? null : (
              <SecretValue id={id} onInput={changeValue} value={value} />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  !(
                    stored ||
                    (value && (card.kind === "model_key" || name.trim()))
                  )
                }
                type="submit"
              >
                {saveLabel(
                  saving,
                  Boolean(progress.current.outcome || recovered),
                  stored
                )}
              </Button>
              <Button
                disabled={stored}
                onClick={decline}
                type="button"
                variant="outline"
              >
                Decline
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Stored in this workspace. The assistant never sees the value.
            </p>
          </>
        )}
        {saving ? (
          <p className="text-muted-foreground text-sm" role="status">
            {card.kind === "confirm" ? "Working…" : "Saving…"}
          </p>
        ) : null}
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}

function ConfirmFields({
  card,
  agents,
  answered,
  onRun,
  onSkip,
}: {
  card: PendingCard;
  agents: AssistantAgent[];
  answered: boolean;
  onRun: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <p className="text-sm">
        Run {card.title.toLowerCase()} with these details?
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
        {Object.entries(card.arguments).map(([key, argument]) => (
          <div className="contents" key={key}>
            <dt className="text-muted-foreground">{argumentLabel(key)}</dt>
            <dd className="min-w-0 break-words">
              {typeof argument === "string"
                ? (agents.find((agent) => agent.id === argument)?.name ??
                  argument)
                : JSON.stringify(argument)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2">
        <Button onClick={onRun} type="button">
          {answered ? "Retry outcome" : "Run"}
        </Button>
        <Button
          disabled={answered}
          onClick={onSkip}
          type="button"
          variant="outline"
        >
          Don't run
        </Button>
      </div>
    </>
  );
}

function SecretFields({
  id,
  name,
  mode,
  rules,
  hosts,
  grantTo,
  agents,
  stored,
  changeName,
  changeMode,
  changeGrants,
  setRules,
  setHosts,
}: {
  id: string;
  name: string;
  mode: "env" | "proxy";
  rules: import("#/components/secrets/secret-model").RuleDraft[];
  hosts: string;
  grantTo: string[];
  agents: AssistantAgent[];
  stored: boolean;
  changeName: (event: ChangeEvent<HTMLInputElement>) => void;
  changeMode: (event: ChangeEvent<HTMLSelectElement>) => void;
  changeGrants: (agentId: string, checked: boolean) => void;
  setRules: (
    rules: import("#/components/secrets/secret-model").RuleDraft[]
  ) => void;
  setHosts: (hosts: string) => void;
}) {
  return (
    <>
      <Label htmlFor={`${id}-name`}>Name</Label>
      <Input
        disabled={stored}
        id={`${id}-name`}
        onChange={changeName}
        value={name}
      />
      <Label htmlFor={`${id}-mode`}>Mode</Label>
      <select
        className="h-9 rounded-md border bg-background px-3 text-sm"
        disabled={stored}
        id={`${id}-mode`}
        onChange={changeMode}
        value={mode}
      >
        <option value="env">Environment variable</option>
        <option value="proxy">Proxy header</option>
      </select>
      <fieldset disabled={stored}>
        {mode === "proxy" ? (
          <RulesEditor onChange={setRules} rules={rules} />
        ) : (
          <AllowedHostsField
            disabled={stored}
            onChange={setHosts}
            value={hosts}
          />
        )}
      </fieldset>
      <fieldset className="min-w-0" disabled={stored}>
        <legend className="mb-2 font-medium text-sm">Grant to agents</legend>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
          {agents.length ? (
            agents.map((agent) => (
              <Label
                className="min-h-9 px-1"
                htmlFor={`${id}-grant-${agent.id}`}
                key={agent.id}
              >
                <Checkbox
                  checked={grantTo.includes(agent.id)}
                  disabled={stored}
                  id={`${id}-grant-${agent.id}`}
                  // biome-ignore lint/performance/noJsxPropsBind: Each checkbox identifies its agent.
                  onCheckedChange={(checked) =>
                    changeGrants(agent.id, checked === true)
                  }
                />
                {agent.name}
              </Label>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">
              No active agents in this workspace.
            </p>
          )}
        </div>
      </fieldset>
    </>
  );
}

function saveLabel(saving: boolean, answered: boolean, stored: boolean) {
  if (saving) {
    return "Saving…";
  }
  if (answered) {
    return "Retry outcome";
  }
  return stored ? "Retry grants" : "Save securely";
}

function initialRules(card: PendingCard) {
  const given = card.arguments.rules;
  return Array.isArray(given) && given.length
    ? given.map((rule) => ({
        ...emptyRule(),
        header: string(rule.header),
        host: string(rule.host),
        template: string(rule.template),
      }))
    : [emptyRule()];
}

function SecretValue({
  id,
  value,
  onInput,
}: {
  id: string;
  value: string;
  onInput: (event: FormEvent<HTMLInputElement>) => void;
}) {
  const [show, setShow] = useState(false);
  const toggleShow = useCallback(() => setShow((was) => !was), []);
  return (
    <>
      <Label htmlFor={`${id}-value`}>Value</Label>
      <div className="flex gap-2">
        <Input
          aria-label="Value"
          autoComplete="off"
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          id={`${id}-value`}
          onInput={onInput}
          style={
            {
              WebkitTextSecurity: show ? "none" : "disc",
            } as CSSProperties
          }
          type="text"
          value={value}
        />
        <Button onClick={toggleShow} type="button" variant="outline">
          {show ? "Hide" : "Show"}
        </Button>
      </div>
    </>
  );
}
