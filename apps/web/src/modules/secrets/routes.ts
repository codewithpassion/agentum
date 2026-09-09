import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalString,
  optionalStringArray,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { getAgentById } from "#/modules/agents/service";
import { requireOwner } from "#/modules/workspaces/require-workspace";
import { parseAllowedHosts } from "./hosts";
import { removeSecretMirror, syncSecretMirror } from "./mirror";
import {
  createSecret,
  deleteSecret,
  getSecret,
  grantSecret,
  isHeaderNameShaped,
  isHeaderPrefixShaped,
  isSecretNameShaped,
  listAgentIdsForSecret,
  listSecrets,
  MissingSecretsKeyError,
  revokeSecret,
  SECRET_DESCRIPTION_MAX_LENGTH,
  SECRET_VALUE_MAX_LENGTH,
  SECRET_VALUE_MIN_LENGTH,
  toSecretView,
  updateSecret,
} from "./service";

/**
 * `/api/w/:workspaceSlug/secrets` - the workspace's own API keys for third
 * party services.
 *
 * Write-only, like the Anthropic key router next door: every response carries a
 * four-character hint and never the value, including the responses that just
 * stored one. Writes are owner-gated; any member may list, because the list is
 * a list of names and hosts, which is information a member needs to reason
 * about what their agents can reach.
 *
 * **No error message here may quote a value.** A rejected secret must not be
 * echoed back to whoever pasted it - not into a response, not into a log.
 * `name` and the hosts are echoed freely; the value never is.
 */

const CONFLICT = 409;
const SERVICE_UNAVAILABLE = 503;
const NAME_MAX_LENGTH = 64;
const HEADER_MAX_LENGTH = 64;
const HEADER_PREFIX_MAX_LENGTH = 32;

/** A header value may not carry a line break: that is request splitting. */
const FORBIDDEN_IN_HEADER_VALUE = /[\r\n\0]/;

/**
 * `requireString` trims, and for a secret's value that is wrong twice over: a
 * key with meaningful leading or trailing whitespace would be silently altered,
 * and the length checks would run against a string we are not storing. Read
 * verbatim, and describe failures without ever quoting what was read.
 */
const readValue = (body: Record<string, unknown>): string => {
  const { value } = body;
  if (typeof value !== "string") {
    throw badRequest('"value" is required.');
  }
  if (value.length < SECRET_VALUE_MIN_LENGTH) {
    throw badRequest(
      `"value" must be at least ${SECRET_VALUE_MIN_LENGTH} characters - anything shorter is entirely revealed by its own hint.`
    );
  }
  if (value.length > SECRET_VALUE_MAX_LENGTH) {
    throw badRequest(
      `"value" must be at most ${SECRET_VALUE_MAX_LENGTH} characters.`
    );
  }
  if (FORBIDDEN_IN_HEADER_VALUE.test(value)) {
    throw badRequest(
      '"value" must not contain line breaks - it is sent as a header.'
    );
  }
  return value;
};

/**
 * Untrimmed for the same reason, and more visibly: the prefix is `"Token "` for
 * Deepgram and `"Bearer "` for most things, and a trim would turn either into a
 * header that fails on every request. An empty prefix is legitimate - it is the
 * `x-api-key` case.
 */
const readHeaderPrefix = (
  body: Record<string, unknown>
): string | undefined => {
  const { headerPrefix: prefix } = body;
  if (prefix === undefined || prefix === null) {
    return;
  }
  if (typeof prefix !== "string") {
    throw badRequest('"headerPrefix" must be a string.');
  }
  if (prefix.length > HEADER_PREFIX_MAX_LENGTH) {
    throw badRequest(
      `"headerPrefix" must be at most ${HEADER_PREFIX_MAX_LENGTH} characters.`
    );
  }
  if (!isHeaderPrefixShaped(prefix)) {
    throw badRequest('"headerPrefix" must not contain line breaks.');
  }
  return prefix;
};

const readHeader = (body: Record<string, unknown>): string | undefined => {
  const header = optionalString(body, "header", {
    maxLength: HEADER_MAX_LENGTH,
  });
  if (header === undefined) {
    return;
  }
  if (!isHeaderNameShaped(header)) {
    throw badRequest(
      `"${header}" is not a valid header name. Use letters, digits and "-", e.g. Authorization or x-api-key.`
    );
  }
  return header;
};

/** Shared by POST and PATCH; absent means "leave it alone" on the latter. */
const readAllowedHosts = (
  body: Record<string, unknown>
): string[] | undefined => {
  const raw = optionalStringArray(body, "allowedHosts");
  if (raw === undefined) {
    return;
  }
  const parsed = parseAllowedHosts(raw);
  if (!parsed.ok) {
    throw badRequest(parsed.reason);
  }
  return parsed.hosts;
};

const readDescription = (body: Record<string, unknown>): string | undefined =>
  optionalString(body, "description", {
    maxLength: SECRET_DESCRIPTION_MAX_LENGTH,
  });

/**
 * The mirror runs behind the response and can never fail a save: the D1 row is
 * the source of truth, and the tool path works whether or not Anthropic has a
 * copy. A failure records itself on the row.
 */
const inBackground = (c: Context<ApiEnv>, work: Promise<unknown>): void => {
  const settled = work.catch(() => {
    // Every failure path records itself on the secret row.
  });
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No execution context (a direct fetch in a test): let it run detached.
  }
};

/** By bare id, and always within the workspace on the request context. */
const requireSecret = async (c: Context<ApiEnv>, db: Db, id: string) => {
  const secret = await getSecret(db, c.get("workspace").id, id);
  if (!secret) {
    throw notFound("Secret not found.");
  }
  return secret;
};

/**
 * An agent of this workspace, or a 404 that reads exactly like a missing one.
 * A 403 here would confirm that an id belongs to *somebody*, which is the
 * existence oracle the isolation suite exists to prevent.
 */
const requireAgent = async (c: Context<ApiEnv>, db: Db, agentId: string) => {
  const agent = await getAgentById(db, c.get("workspace").id, agentId);
  if (!agent) {
    throw notFound("Agent not found.");
  }
  return agent;
};

/** With no `CONNECTOR_KEY` there is nothing to encrypt with, so nothing to store. */
const asHttpResponse = (c: Context<ApiEnv>, error: unknown): Response => {
  if (error instanceof MissingSecretsKeyError) {
    return c.json(
      { error: "This deployment cannot store secrets. Contact your admin." },
      SERVICE_UNAVAILABLE
    );
  }
  throw error;
};

export const secretsRoutes = new Hono<ApiEnv>();

// `requireWorkspace` comes from the mount; this is the authentication gate.
// `requireOwner` is applied per route, because listing is open to any member.
secretsRoutes.use("*", requireAuth);

secretsRoutes.get("/", async (c) =>
  c.json({
    secrets: await listSecrets(createDb(c.env.DB), c.get("workspace").id),
  })
);

secretsRoutes.post("/", requireOwner, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", { maxLength: NAME_MAX_LENGTH });
  if (!isSecretNameShaped(name)) {
    throw badRequest(
      `"${name}" is not a valid secret name. Use an environment-variable style name: capitals, digits and underscores, starting with a letter, e.g. DEEPGRAM_API_KEY.`
    );
  }

  const allowedHosts = readAllowedHosts(body);
  if (allowedHosts === undefined) {
    throw badRequest(
      '"allowedHosts" is required - a secret with no allowed hosts can never be used.'
    );
  }

  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;

  try {
    const secret = await createSecret(db, c.env, workspaceId, {
      allowedHosts,
      clerkUserId: c.get("userId"),
      description: readDescription(body),
      header: readHeader(body),
      headerPrefix: readHeaderPrefix(body),
      name,
      value: readValue(body),
    });
    inBackground(c, syncSecretMirror(db, c.env, workspaceId, secret.id));
    return c.json({ secret: toSecretView(secret) }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json(
        { error: `This workspace already has a secret named ${name}.` },
        CONFLICT
      );
    }
    return asHttpResponse(c, error);
  }
});

/**
 * `name` is deliberately not patchable: the tool and the sandbox both key on
 * it, so a rename is a delete and a create. A body that tries is refused rather
 * than silently ignored.
 */
secretsRoutes.patch("/:id", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const secret = await requireSecret(c, db, c.req.param("id"));
  const body = await readJsonObject(c.req.raw);

  if ("name" in body) {
    throw badRequest(
      "A secret's name cannot be changed - agents and sandboxes address it by name. Delete it and add it again."
    );
  }

  const workspaceId = c.get("workspace").id;
  try {
    const updated = await updateSecret(db, c.env, workspaceId, secret.id, {
      allowedHosts: readAllowedHosts(body),
      description: readDescription(body),
      header: readHeader(body),
      headerPrefix: readHeaderPrefix(body),
      ...("value" in body ? { value: readValue(body) } : {}),
    });
    if (!updated) {
      throw notFound("Secret not found.");
    }
    inBackground(c, syncSecretMirror(db, c.env, workspaceId, updated.id));
    return c.json({
      secret: toSecretView(
        updated,
        await listAgentIdsForSecret(db, updated.id)
      ),
    });
  } catch (error) {
    return asHttpResponse(c, error);
  }
});

/**
 * The mirror is archived before the row goes, because it is the row that says
 * which credential to archive - but it still runs in the background, so a
 * failed archive cannot block the delete.
 */
secretsRoutes.delete("/:id", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const secret = await requireSecret(c, db, c.req.param("id"));
  const workspaceId = c.get("workspace").id;

  // The row is handed over, not its id: this runs while the delete proceeds,
  // and a mirror that had to read the row back would race it.
  inBackground(c, removeSecretMirror(db, c.env, secret));
  await deleteSecret(db, workspaceId, secret.id);
  return c.body(null, 204);
});

// --- grants -----------------------------------------------------------------

/**
 * Idempotent: granting a secret an agent already holds is a 200, not a
 * conflict. The vault ids are fixed when a managed session is created, so the
 * grant reaches a managed agent's *sandbox* on its next session - while the
 * tool path, which reads the join on every call, has it immediately.
 */
secretsRoutes.put("/:id/agents/:agentId", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const secret = await requireSecret(c, db, c.req.param("id"));
  const agent = await requireAgent(c, db, c.req.param("agentId"));

  await grantSecret(db, secret.id, agent.id);
  return c.json({ appliesToNextSession: true, granted: true });
});

secretsRoutes.delete("/:id/agents/:agentId", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const secret = await requireSecret(c, db, c.req.param("id"));
  const agent = await requireAgent(c, db, c.req.param("agentId"));

  if (!(await revokeSecret(db, secret.id, agent.id))) {
    throw notFound("That agent has not been granted this secret.");
  }
  return c.body(null, 204);
});
