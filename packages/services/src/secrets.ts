/**
 * Workspace secrets for agents (S.3). A secret has a name (an environment
 * variable name), a value and a mode: `env` sets it as a variable where the
 * agent runs, `proxy` adds it to outgoing requests that match a rule, so the
 * code never holds it. The value is AES-GCM encrypted under `SECRETS_KEY`
 * and write-only: no method returns it except `resolveForAgent`, `proxyFor`
 * and `maskerFor`, which the runtimes, the outbound entrypoint and the relay
 * call and which never reach a router.
 *
 * Grants are per agent. Nothing here reads the Worker's own secrets, and a name
 * that would clash with them, with the run token or with the model key is
 * refused, so none of them can be delivered through this store.
 *
 * No method, error or event carries a value.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { agentSecrets, secrets } from "@repo/db/schema/secrets";
import { SECRET_MODES, type SecretMode } from "@repo/db/shared";
import { createMasker, type Masker } from "@repo/protocol/masker";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  importSecretsKey,
  type SecretBinding,
} from "./crypto.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import {
  isHeaderSafe,
  matchHost,
  normalizeHost,
  type Rule,
  renderHeader,
  rulesSchema,
  storedRulesSchema,
} from "./secrets/rules.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "secrets.read";
const WRITE_ACTION = "secrets.write";
const SECRET_KIND = "secret";

export const NAME_MAX = 64;
export const VALUE_MIN = 8;
export const VALUE_MAX = 4096;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names the Worker, Claude Code or the OS read, which a secret must not set. */
const RESERVED_NAMES = new Set([
  "ALL_PROXY",
  "ALLOWED_ORG_IDS",
  "BASH_ENV",
  "CURL_CA_BUNDLE",
  "ENV",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_PROXY",
  "PATH",
  "PERLLIB",
  "PROMPT_COMMAND",
  "PUBLIC_BASE_URL",
  "RUN_TOKEN_KEY",
  "REQUESTS_CA_BUNDLE",
  "SECRETS_KEY",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "USER",
]);
const RESERVED_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE",
  "CLERK_",
  "DYLD_",
  "GIT_",
  "HARBOURMASTER_",
  "HM_",
  "LD_",
  "PERL5",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "RUBYLIB",
  "XDG_",
];
/** Harbourmaster's own tokens start with this: a run token, a key, a machine credential. */
const TOKEN_PREFIX = "hm_";
const NUL = "\0";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX)
  .regex(
    NAME_PATTERN,
    "A name is letters, digits and underscores, and does not start with a digit"
  )
  .refine(
    (name) =>
      !(
        RESERVED_NAMES.has(name.toUpperCase()) ||
        RESERVED_PREFIXES.some((prefix) =>
          name.toUpperCase().startsWith(prefix)
        )
      ),
    { message: "That name is reserved" }
  );

const valueSchema = z
  .string()
  .min(VALUE_MIN, `A value is at least ${VALUE_MIN} characters`)
  .max(VALUE_MAX)
  .refine((value) => !value.includes(NUL), {
    message: "A value cannot hold a NUL character",
  })
  .refine((value) => !value.startsWith(TOKEN_PREFIX), {
    message: "That looks like a Harbourmaster token, which cannot be stored",
  });

const modeSchema = z.enum(SECRET_MODES);

/** A proxy secret has rules, an env secret has none. */
export const secretCreateSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("env"),
    name: nameSchema,
    value: valueSchema,
  }),
  z.strictObject({
    mode: z.literal("proxy"),
    name: nameSchema,
    rules: rulesSchema,
    value: valueSchema,
  }),
]);
export type SecretCreateInput = z.input<typeof secretCreateSchema>;

/** Each field replaces what the secret has. A value is never read back, only replaced. */
export const secretUpdateSchema = z
  .strictObject({
    mode: modeSchema.optional(),
    rules: rulesSchema.optional(),
    value: valueSchema.optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((field) => field !== undefined),
    "Nothing to update"
  );
export type SecretUpdateInput = z.input<typeof secretUpdateSchema>;

const idString = z.string().min(1).max(200);
const grantIdsSchema = z.array(idString).max(100);

/** A secret as a reader sees it: everything but the value. */
export interface SecretSummary {
  createdAt: string;
  id: string;
  mode: SecretMode;
  name: string;
  rules: Rule[];
  updatedAt: string;
}

/** A granted secret as a runtime needs it. The value is plaintext: keep it out of logs and events. */
export interface GrantedSecret {
  id: string;
  mode: SecretMode;
  name: string;
  rules: Rule[];
  value: string;
  version: number;
}

/**
 * What an agent is granted, for one run. `env` holds the values to set,
 * `proxy` the names and rules for guidance and the events (no values). The
 * `revision` changes whenever a grant, a value or a rule does, so a runtime
 * that caches work per revision starts over.
 */
export interface ResolvedSecrets {
  env: Record<string, string>;
  masker: Masker;
  proxy: { hosts: string[]; name: string }[];
  revision: string;
}

/** One rule that applies to a request: the header to set, and the value it holds. */
export interface ProxyMatch {
  header: string;
  headerValue: string;
  name: string;
  /** The secret itself, for scrubbing it out of an answer. */
  value: string;
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type SecretRow = typeof secrets.$inferSelect;

const nameTaken = () =>
  new ServiceError("conflict", "A secret with that name already exists");

const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

const binding = (workspaceId: string, secretId: string): SecretBinding => ({
  field: "value",
  rowId: secretId,
  table: "secrets",
  workspaceId,
});

const rulesOf = (row: Pick<SecretRow, "rules">): Rule[] =>
  storedRulesSchema.parse(JSON.parse(row.rules));

const toSummary = (row: SecretRow): SecretSummary => ({
  createdAt: row.createdAt,
  id: row.id,
  mode: row.mode,
  name: row.name,
  rules: rulesOf(row),
  updatedAt: row.updatedAt,
});

/** The rules a secret has after an update: none for `env`, the new ones or the old ones for `proxy`. */
const rulesFor = (
  mode: SecretMode,
  given: Rule[] | undefined,
  row: Pick<SecretRow, "mode" | "rules">
): Rule[] => {
  if (mode === "env") {
    if (given !== undefined) {
      throw new ServiceError("invalid", "An env secret has no rules");
    }
    return [];
  }
  const rules = given ?? (row.mode === "proxy" ? rulesOf(row) : []);
  if (rules.length === 0) {
    throw new ServiceError("invalid", "A proxy secret needs at least one rule");
  }
  return rules;
};

/** A proxy secret's value goes into a header, so it has to be one. */
const checkValueFitsMode = (mode: SecretMode, value: string): void => {
  if (mode === "proxy" && !isHeaderSafe(value)) {
    throw new ServiceError(
      "invalid",
      "A proxy secret's value may hold printable ASCII only"
    );
  }
};

export const createSecretsService = ({
  atomic,
  clock,
  db,
  events,
  secretsKey,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /** `SECRETS_KEY`, base64. Needed to store or read a value. */
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing secrets needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const requireSecret = async (
    workspaceId: string,
    id: string
  ): Promise<SecretRow> => {
    const [row] = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.workspaceId, workspaceId)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Secret not found");
    }
    return row;
  };

  const list = async (principal: Principal): Promise<SecretSummary[]> => {
    const user = requireUser(principal, READ_ACTION);
    authorize(user, READ_ACTION, {
      kind: SECRET_KIND,
      workspaceId: user.workspaceId,
    });
    const rows = await db
      .select()
      .from(secrets)
      .where(eq(secrets.workspaceId, user.workspaceId))
      .orderBy(asc(secrets.name));
    return rows.map(toSummary);
  };

  const create = async (
    principal: Principal,
    input: SecretCreateInput
  ): Promise<SecretSummary> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: SECRET_KIND, workspaceId });
    const parsed = secretCreateSchema.parse(input);
    const { mode, name, value } = parsed;
    checkValueFitsMode(mode, value);
    const key = await cryptoKey();
    const id = ulid();
    const now = clock.now().toISOString();
    const row: SecretRow = {
      createdAt: now,
      createdBy: user.userId,
      id,
      mode,
      name,
      rules: JSON.stringify(parsed.mode === "proxy" ? parsed.rules : []),
      updatedAt: now,
      valueEnc: await encryptSecret(key, binding(workspaceId, id), value),
      version: 1,
      workspaceId,
    };
    try {
      await db.insert(secrets).values(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw nameTaken();
      }
      throw error;
    }
    return toSummary(row);
  };

  /** Replaces the value, the mode and rules, or both. The old value is gone for good. */
  const update = async (
    principal: Principal,
    id: string,
    input: SecretUpdateInput
  ): Promise<SecretSummary> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { id, kind: SECRET_KIND, workspaceId });
    const patch = secretUpdateSchema.parse(input);
    const row = await requireSecret(workspaceId, id);
    const mode = patch.mode ?? row.mode;
    const rules = rulesFor(mode, patch.rules, row);
    const key = await cryptoKey();
    // A mode change needs the value it must fit, so a proxy rule never meets a value that cannot be a header.
    const plain =
      patch.value ??
      (await decryptSecret(key, binding(workspaceId, id), row.valueEnc));
    checkValueFitsMode(mode, plain);
    const valueEnc =
      patch.value === undefined
        ? row.valueEnc
        : await encryptSecret(key, binding(workspaceId, id), patch.value);
    const next: SecretRow = {
      ...row,
      mode,
      rules: JSON.stringify(rules),
      updatedAt: clock.now().toISOString(),
      valueEnc,
      version: row.version + 1,
    };
    await db
      .update(secrets)
      .set({
        mode: next.mode,
        rules: next.rules,
        updatedAt: next.updatedAt,
        valueEnc: next.valueEnc,
        version: next.version,
      })
      .where(and(eq(secrets.id, id), eq(secrets.workspaceId, workspaceId)));
    return toSummary(next);
  };

  /** Deletes the secret and every grant of it. Idempotent. */
  const remove = async (principal: Principal, id: string): Promise<void> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { id, kind: SECRET_KIND, workspaceId });
    await atomic([
      db
        .delete(agentSecrets)
        .where(
          and(
            eq(agentSecrets.secretId, id),
            eq(agentSecrets.workspaceId, workspaceId)
          )
        ),
      db
        .delete(secrets)
        .where(and(eq(secrets.id, id), eq(secrets.workspaceId, workspaceId))),
    ]);
  };

  const requireAgent = async (workspaceId: string, agentId: string) => {
    const agent = await findAgent(db, { id: agentId, workspaceId });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
  };

  /** The ids of the secrets an agent is granted. */
  const grantsOf = async (
    principal: Principal,
    agentId: string
  ): Promise<string[]> => {
    const user = requireUser(principal, READ_ACTION);
    authorize(user, READ_ACTION, {
      kind: SECRET_KIND,
      workspaceId: user.workspaceId,
    });
    await requireAgent(user.workspaceId, agentId);
    const rows = await db
      .select({ secretId: agentSecrets.secretId })
      .from(agentSecrets)
      .where(
        and(
          eq(agentSecrets.agentId, agentId),
          eq(agentSecrets.workspaceId, user.workspaceId)
        )
      );
    return rows.map((row) => row.secretId).sort();
  };

  /** Makes `secretIds` the agent's whole grant set. */
  const setGrants = async (
    principal: Principal,
    agentId: string,
    secretIds: string[]
  ): Promise<string[]> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: SECRET_KIND, workspaceId });
    const ids = [...new Set(grantIdsSchema.parse(secretIds))];
    await requireAgent(workspaceId, agentId);
    if (ids.length > 0) {
      const found = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(eq(secrets.workspaceId, workspaceId), inArray(secrets.id, ids))
        );
      if (found.length !== ids.length) {
        throw new ServiceError("not_found", "Secret not found");
      }
    }
    const now = clock.now().toISOString();
    await atomic([
      db
        .delete(agentSecrets)
        .where(
          and(
            eq(agentSecrets.agentId, agentId),
            eq(agentSecrets.workspaceId, workspaceId)
          )
        ),
      ...(ids.length === 0
        ? []
        : [
            db.insert(agentSecrets).values(
              ids.map((secretId) => ({
                agentId,
                createdAt: now,
                secretId,
                workspaceId,
              }))
            ),
          ]),
    ]);
    return ids.sort();
  };

  /** The agent's granted secrets, decrypted. Internal: callers keep the values out of anything stored or shown. */
  const grantedTo = async (
    workspaceId: string,
    agentId: string
  ): Promise<GrantedSecret[]> => {
    const rows = await db
      .select({ row: secrets })
      .from(agentSecrets)
      .innerJoin(secrets, eq(secrets.id, agentSecrets.secretId))
      .where(
        and(
          eq(agentSecrets.agentId, agentId),
          eq(agentSecrets.workspaceId, workspaceId),
          eq(secrets.workspaceId, workspaceId)
        )
      )
      .orderBy(asc(secrets.name));
    if (rows.length === 0) {
      return [];
    }
    const key = await cryptoKey();
    return await Promise.all(
      rows.map(async ({ row }) => ({
        id: row.id,
        mode: row.mode,
        name: row.name,
        rules: rulesOf(row),
        value: await decryptSecret(
          key,
          binding(workspaceId, row.id),
          row.valueEnc
        ),
        version: row.version,
      }))
    );
  };

  const maskerOf = (granted: readonly GrantedSecret[]): Masker =>
    createMasker(
      Object.fromEntries(granted.map((secret) => [secret.name, secret.value]))
    );

  /** What a runtime hands to the agent for this run. */
  const resolveForAgent = async (
    workspaceId: string,
    agentId: string
  ): Promise<ResolvedSecrets> => {
    const granted = await grantedTo(workspaceId, agentId);
    return {
      env: Object.fromEntries(
        granted
          .filter((secret) => secret.mode === "env")
          .map((secret) => [secret.name, secret.value])
      ),
      masker: maskerOf(granted),
      proxy: granted
        .filter((secret) => secret.mode === "proxy")
        .map((secret) => ({
          hosts: [...new Set(secret.rules.map((rule) => rule.host))],
          name: secret.name,
        })),
      revision: await hashToken(
        JSON.stringify(granted.map((secret) => [secret.id, secret.version]))
      ),
    };
  };

  /** The masker for the agent's granted values, or null when it has none. */
  const maskerFor = async (
    workspaceId: string,
    agentId: string
  ): Promise<Masker | null> => {
    const granted = await grantedTo(workspaceId, agentId);
    return granted.length === 0 ? null : maskerOf(granted);
  };

  /** The proxy rules that apply to a request to `host`, with the values they send. Empty when none is granted. */
  const proxyFor = async (
    workspaceId: string,
    agentId: string,
    host: string
  ): Promise<ProxyMatch[]> => {
    const target = normalizeHost(host);
    const granted = await grantedTo(workspaceId, agentId);
    return granted
      .filter((secret) => secret.mode === "proxy")
      .flatMap((secret) =>
        secret.rules
          .filter((rule) => matchHost(rule.host, target))
          .map((rule) => ({
            header: rule.header,
            headerValue: renderHeader(rule, secret.value),
            name: secret.name,
            value: secret.value,
          }))
      );
  };

  const sessionOf = async (
    workspaceId: string,
    runId: string
  ): Promise<string | null> => {
    const [run] = await db
      .select({ sessionId: runs.sessionId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    return run?.sessionId ?? null;
  };

  const runEvent = async (
    type: "secret.delivered" | "secret.injected",
    run: { agentId: string; runId: string; workspaceId: string },
    payload: Record<
      string,
      string | string[] | { hosts: string[]; name: string }[]
    >
  ): Promise<void> => {
    await events.append({
      actor: { id: run.agentId, kind: "agent" },
      agentId: run.agentId,
      payload,
      runId: run.runId,
      sessionId: await sessionOf(run.workspaceId, run.runId),
      type,
      workspaceId: run.workspaceId,
    });
  };

  /** A run was handed secrets. Names and hosts only. Does nothing when there are none. */
  const announceDelivery = async (
    run: { agentId: string; runId: string; workspaceId: string },
    delivery: {
      env: readonly string[];
      proxy: readonly { hosts: string[]; name: string }[];
      surface: "cloud" | "machine" | "managed";
    }
  ): Promise<void> => {
    if (delivery.env.length === 0 && delivery.proxy.length === 0) {
      return;
    }
    const given = [
      ...delivery.env.map((name) => `${name} (env)`),
      ...delivery.proxy.map(
        (entry) => `${entry.name} (proxy: ${entry.hosts.join(", ")})`
      ),
    ];
    await runEvent("secret.delivered", run, {
      env: [...delivery.env],
      proxy: delivery.proxy.map((entry) => ({
        hosts: entry.hosts,
        name: entry.name,
      })),
      surface: delivery.surface,
      text: `Run received ${given.join(", ")}`,
    });
  };

  /** The proxy or the relay added secrets to a request. Names and the host only. */
  const announceInjection = async (
    run: { agentId: string; runId: string; workspaceId: string },
    injection: {
      host: string;
      names: readonly string[];
      via: "outbound" | "relay";
    }
  ): Promise<void> => {
    await runEvent("secret.injected", run, {
      host: injection.host,
      names: [...injection.names],
      text: `Added ${injection.names.join(", ")} to a request to ${injection.host}`,
      via: injection.via,
    });
  };

  return {
    announceDelivery,
    announceInjection,
    create,
    grantsOf,
    list,
    maskerFor,
    proxyFor,
    remove,
    resolveForAgent,
    setGrants,
    update,
  };
};

export type SecretsService = ReturnType<typeof createSecretsService>;
