/**
 * Where a peer wants a task's updates pushed, and the outbox rows a state
 * change queues for it. A config holds at most a URL, an authentication scheme
 * with credentials and a token. The last two are encrypted at rest, bound to
 * their row, and never read back: a response names the URL and the scheme only.
 * Delivery is AA.5's outbox. The spec is docs/v3/agent-connections.md.
 */
import type { TaskPushNotificationConfig } from "@repo/a2a/requests";
import type { Database } from "@repo/db";
import {
  a2aConnections,
  type a2aOutbox,
  a2aPushConfigs,
} from "@repo/db/schema/a2a";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { checkUrl } from "../connectors/safe-url.ts";
import {
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import { A2aTaskError } from "./errors.ts";
import { type TaskRow, toTask } from "./task-view.ts";

/** Push configs one task may hold. */
export const PUSH_CONFIGS_PER_TASK = 5;

/** The header a push carries its `token` in. The spec does not say where it goes. */
export const NOTIFICATION_TOKEN_HEADER = "X-A2A-Notification-Token";

const CLIENT_ID_MAX = 100;
const URL_MAX = 2000;
const SCHEME_MAX = 100;
const SECRET_MAX = 2000;

export const pushConfigInputSchema = z.object({
  authentication: z
    .object({
      credentials: z.string().max(SECRET_MAX).optional(),
      scheme: z.string().min(1).max(SCHEME_MAX),
    })
    .optional(),
  id: z.string().min(1).max(CLIENT_ID_MAX).optional(),
  token: z.string().min(1).max(SECRET_MAX).optional(),
  url: z.string().min(1).max(URL_MAX),
});
export type PushConfigInput = z.input<typeof pushConfigInputSchema>;

/** What a peer may read of a config. No credentials and no token. */
export type PushConfigView = Pick<
  TaskPushNotificationConfig,
  "id" | "taskId" | "url"
> & {
  authentication?: { scheme: string };
};

type ConfigRow = typeof a2aPushConfigs.$inferSelect;
export type OutboxInsert = typeof a2aOutbox.$inferInsert;

const storedAuthSchema = z.object({
  credentials: z.string().optional(),
  scheme: z.string(),
});

export const createPushConfigs = ({
  allowLoopback = false,
  clock,
  db,
  secretsKey,
}: {
  /** Dev builds only: a webhook may be on localhost over plain http. */
  allowLoopback?: boolean;
  clock: Clock;
  db: Database;
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const key = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing a credential needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };
  const seal = async (binding: SecretBinding, plaintext: string) =>
    await encryptSecret(await key(), binding, plaintext);
  const unseal = async (binding: SecretBinding, stored: string) =>
    await decryptSecret(await key(), binding, stored);
  const nowIso = () => clock.now().toISOString();

  const configBinding = (
    row: Pick<ConfigRow, "id" | "workspaceId">,
    field: "authentication" | "token"
  ): SecretBinding => ({
    field,
    rowId: row.id,
    table: "a2a_push_configs",
    workspaceId: row.workspaceId,
  });

  /** A URL that passes the safe-URL guard, or a refusal in the person's words. */
  const vetUrl = (raw: string): string => {
    const checked = checkUrl(raw, { allowLoopback });
    if (!checked.ok) {
      throw new ServiceError(
        "invalid",
        `That URL is not allowed: ${checked.reason}.`
      );
    }
    return checked.url.toString();
  };

  /** The id a peer sees: its own, without the task prefix we store it under. */
  const publicId = (row: Pick<ConfigRow, "id" | "taskId">): string =>
    row.id.startsWith(`${row.taskId}:`)
      ? row.id.slice(row.taskId.length + 1)
      : row.id;

  const view = async (row: ConfigRow): Promise<PushConfigView> => {
    const auth = row.authentication
      ? storedAuthSchema.parse(
          JSON.parse(
            await unseal(
              configBinding(row, "authentication"),
              row.authentication
            )
          )
        )
      : null;
    return {
      ...(auth === null ? {} : { authentication: { scheme: auth.scheme } }),
      id: publicId(row),
      taskId: row.taskId,
      url: row.url,
    };
  };

  /** Throws unless `raw` would be accepted. Call before creating a task. */
  const validate = (
    raw: PushConfigInput
  ): z.output<typeof pushConfigInputSchema> => {
    const input = pushConfigInputSchema.parse(raw);
    vetUrl(input.url);
    if ((input.authentication || input.token) && !secretsKey) {
      throw new Error("Storing a credential needs secretsKey (SECRETS_KEY).");
    }
    return input;
  };

  const create = async (
    task: Pick<TaskRow, "id" | "workspaceId">,
    raw: PushConfigInput
  ): Promise<PushConfigView> => {
    const input = validate(raw);
    const url = vetUrl(input.url);
    const id = input.id
      ? `${task.id}:${input.id}`
      : ulid(clock.now().getTime());
    const base = { id, workspaceId: task.workspaceId };
    const row = {
      authentication: input.authentication
        ? await seal(
            configBinding(base, "authentication"),
            JSON.stringify(input.authentication)
          )
        : null,
      createdAt: nowIso(),
      id,
      taskId: task.id,
      token: input.token
        ? await seal(configBinding(base, "token"), input.token)
        : null,
      url,
      workspaceId: task.workspaceId,
    };
    // The count is part of the insert, so two creates cannot both take the last place.
    let inserted: { id: string }[] = [];
    let duplicate = false;
    try {
      inserted = await db
        .insert(a2aPushConfigs)
        .select(
          db
            .select({
              authentication: sql<string | null>`${row.authentication}`.as(
                "authentication"
              ),
              createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
              id: sql<string>`${row.id}`.as("id"),
              taskId: sql<string>`${row.taskId}`.as("taskId"),
              token: sql<string | null>`${row.token}`.as("token"),
              url: sql<string>`${row.url}`.as("url"),
              workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
            })
            .from(sql`(select 1)`)
            .where(
              sql`(select count(*) from ${a2aPushConfigs} where ${a2aPushConfigs.taskId} = ${row.taskId}) < ${PUSH_CONFIGS_PER_TASK}`
            )
        )
        .returning({ id: a2aPushConfigs.id });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      duplicate = true;
    }
    if (duplicate) {
      throw new ServiceError("conflict", "That push configuration exists");
    }
    if (inserted.length === 0) {
      throw new ServiceError(
        "invalid",
        `A task holds at most ${PUSH_CONFIGS_PER_TASK} push configurations`
      );
    }
    return await view({ ...row });
  };

  const rowOf = async (
    taskId: string,
    configId: string
  ): Promise<ConfigRow | null> => {
    const [row] = await db
      .select()
      .from(a2aPushConfigs)
      .where(
        and(
          eq(a2aPushConfigs.taskId, taskId),
          inArray(a2aPushConfigs.id, [configId, `${taskId}:${configId}`])
        )
      )
      .limit(1);
    return row ?? null;
  };

  const notFound = () =>
    new A2aTaskError("TaskNotFoundError", "Push configuration not found");

  const get = async (taskId: string, configId: string) => {
    const row = await rowOf(taskId, configId);
    if (!row) {
      throw notFound();
    }
    return await view(row);
  };

  const list = async (taskId: string): Promise<PushConfigView[]> => {
    const rows = await db
      .select()
      .from(a2aPushConfigs)
      .where(eq(a2aPushConfigs.taskId, taskId))
      .orderBy(asc(a2aPushConfigs.createdAt), asc(a2aPushConfigs.id));
    return await Promise.all(rows.map(view));
  };

  /** Idempotent, as spec 3.1.10 asks: deleting a config that is gone is the same as deleting it. */
  const remove = async (taskId: string, configId: string): Promise<void> => {
    const row = await rowOf(taskId, configId);
    if (row) {
      await db.delete(a2aPushConfigs).where(eq(a2aPushConfigs.id, row.id));
    }
  };

  /** The headers a push to this config carries, or null when it needs none. */
  const headersOf = async (
    config: ConfigRow
  ): Promise<Record<string, string> | null> => {
    const headers: Record<string, string> = {};
    if (config.authentication) {
      const auth = storedAuthSchema.parse(
        JSON.parse(
          await unseal(
            configBinding(config, "authentication"),
            config.authentication
          )
        )
      );
      headers.Authorization = auth.credentials
        ? `${auth.scheme} ${auth.credentials}`
        : auth.scheme;
    }
    if (config.token) {
      headers[NOTIFICATION_TOKEN_HEADER] = await unseal(
        configBinding(config, "token"),
        config.token
      );
    }
    return Object.keys(headers).length === 0 ? null : headers;
  };

  /**
   * One `push` outbox row per config for a task that is about to change state,
   * with the whole task as a `StreamResponse`. The caller writes them in the
   * same atomic write as the state change. None for a connection that is no
   * longer active: a revoked peer hears nothing more.
   */
  const rowsFor = async (task: TaskRow): Promise<OutboxInsert[]> => {
    const configs = await db
      .select()
      .from(a2aPushConfigs)
      .where(eq(a2aPushConfigs.taskId, task.id));
    if (configs.length === 0) {
      return [];
    }
    const [connection] = await db
      .select({ status: a2aConnections.status })
      .from(a2aConnections)
      .where(eq(a2aConnections.id, task.connectionId))
      .limit(1);
    if (connection?.status !== "active") {
      return [];
    }
    const body = JSON.stringify({ task: toTask(task) });
    const rows: OutboxInsert[] = [];
    for (const config of configs) {
      const id = `obx_${ulid(clock.now().getTime())}`;
      // biome-ignore lint/performance/noAwaitInLoops: at most five configs per task
      const headers = await headersOf(config);
      rows.push({
        attempts: 0,
        body,
        connectionId: task.connectionId,
        createdAt: nowIso(),
        headers: headers
          ? await seal(
              {
                field: "headers",
                rowId: id,
                table: "a2a_outbox",
                workspaceId: task.workspaceId,
              },
              JSON.stringify(headers)
            )
          : null,
        id,
        kind: "push",
        nextAttemptAt: nowIso(),
        url: config.url,
        workspaceId: task.workspaceId,
      });
    }
    return rows;
  };

  return { create, get, list, remove, rowsFor, validate };
};

export type PushConfigs = ReturnType<typeof createPushConfigs>;
