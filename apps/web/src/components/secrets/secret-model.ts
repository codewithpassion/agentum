import type { SecretMode } from "@repo/db/shared";
import { matchHost } from "@repo/services/secrets/rules";
import type { RouterOutputs } from "#/integrations/trpc/types";

export type SecretRecord = RouterOutputs["secrets"]["list"][number];

/** The rules editor's row: `id` keys the row, the rest is what the server takes. */
export interface RuleDraft {
  header: string;
  host: string;
  id: string;
  template: string;
}

export type ActiveDialog =
  | { kind: "create" }
  | { kind: "replace"; secret: SecretRecord }
  | { kind: "rules"; secret: SecretRecord }
  | { kind: "hosts"; secret: SecretRecord }
  | { kind: "mode"; secret: SecretRecord }
  | { kind: "delete"; secret: SecretRecord };

/** Matches the server's limit on rules per secret. */
export const MAX_RULES = 8;
export const DEFAULT_HEADER = "Authorization";
export const DEFAULT_TEMPLATE = "Bearer {value}";

export const emptyRule = (): RuleDraft => ({
  header: DEFAULT_HEADER,
  host: "",
  id: crypto.randomUUID(),
  template: DEFAULT_TEMPLATE,
});

export const toRuleDrafts = (rules: SecretRecord["rules"]): RuleDraft[] =>
  rules.map((rule) => ({ ...rule, id: crypto.randomUUID() }));

export const addRule = (rules: RuleDraft[]): RuleDraft[] =>
  rules.length < MAX_RULES ? [...rules, emptyRule()] : rules;

/** Keeps at least one row, since a proxy secret needs a rule. */
export const removeRule = (rules: RuleDraft[], id: string): RuleDraft[] =>
  rules.length > 1 ? rules.filter((rule) => rule.id !== id) : rules;

export const changeRule = (
  rules: RuleDraft[],
  id: string,
  field: Exclude<keyof RuleDraft, "id">,
  value: string
): RuleDraft[] =>
  rules.map((rule) => (rule.id === id ? { ...rule, [field]: value } : rule));

/** The rules as the server takes them: host and header trimmed, the template as typed. */
export const toRules = (rules: RuleDraft[]) =>
  rules.map((rule) => ({
    header: rule.header.trim(),
    host: rule.host.trim(),
    template: rule.template,
  }));

/** A proxy rule needs a host. Other fields are checked by the server. */
export const rulesReady = (rules: RuleDraft[]): boolean =>
  rules.every((rule) => rule.host.trim() !== "");

const HOST_SEPARATOR = /[\s,]+/;

/** Splits typed hosts on commas and whitespace, dropping repeats and empty entries. */
export const parseHosts = (text: string): string[] => [
  ...new Set(text.split(HOST_SEPARATOR).filter((host) => host !== "")),
];

export const hostsText = (hosts: readonly string[]): string => hosts.join(", ");

export const hostsOf = (secret: SecretRecord): string => {
  if (secret.mode === "proxy") {
    return hostsText(secret.rules.map((rule) => rule.host));
  }
  return secret.allowedHosts.length > 0 ? hostsText(secret.allowedHosts) : "-";
};

/**
 * What the Change mode dialog starts with for both modes, from the secret's
 * current settings where they map. Proxy rule hosts become allowed hosts. An
 * env secret's allowed hosts become rules with the default header and template,
 * which stay editable.
 */
export const modeChangeDefaults = (
  secret: SecretRecord
): { hosts: string; rules: RuleDraft[] } => {
  if (secret.mode === "proxy") {
    return {
      hosts: hostsText([...new Set(secret.rules.map((rule) => rule.host))]),
      rules: toRuleDrafts(secret.rules),
    };
  }
  return {
    hosts: hostsText(secret.allowedHosts),
    rules:
      secret.allowedHosts.length > 0
        ? secret.allowedHosts.map((host) => ({ ...emptyRule(), host }))
        : [emptyRule()],
  };
};

/** The `secrets.update` patch that switches to `mode` with the settings typed for it. */
export const modePatch = (
  mode: SecretMode,
  rules: RuleDraft[],
  hosts: string
) =>
  mode === "proxy"
    ? { mode, rules: toRules(rules) }
    : { allowedHosts: parseHosts(hosts), mode };

/** The hosts the new settings allow: the rules' hosts for proxy, the typed hosts for env. */
export const newHosts = (
  mode: SecretMode,
  rules: RuleDraft[],
  hosts: string
): string[] =>
  mode === "proxy"
    ? rules.map((rule) => rule.host.trim()).filter((host) => host !== "")
    : parseHosts(hosts);

/**
 * The names of the connectors linked to the secret whose host the new settings
 * would not allow, the same host check a connector call makes
 * (`checkConnectorSecretHost`).
 */
export const connectorsAtRisk = (
  connectors: readonly { name: string; secretId: string | null; url: string }[],
  secretId: string,
  hosts: readonly string[]
): string[] =>
  connectors
    .filter((connector) => connector.secretId === secretId)
    .filter((connector) => {
      try {
        const host = new URL(connector.url).hostname;
        return !hosts.some((pattern) => matchHost(pattern, host));
      } catch {
        return false;
      }
    })
    .map((connector) => connector.name);
