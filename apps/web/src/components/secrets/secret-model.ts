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
  | { kind: "delete"; secret: SecretRecord };

/** Matches the server's limit on rules per secret. */
export const MAX_RULES = 8;
export const DEFAULT_HEADER = "Authorization";
export const DEFAULT_TEMPLATE = "Bearer {value}";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

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

export const hostsOf = (secret: SecretRecord): string =>
  secret.mode === "proxy"
    ? secret.rules.map((rule) => rule.host).join(", ")
    : "-";
