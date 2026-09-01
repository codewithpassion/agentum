import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalBoolean,
  optionalString,
  readJsonObject,
  requireEnum,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { listAgentIdsForComputerHost } from "#/modules/agents/service";
import { requireOwner } from "#/modules/workspaces/require-workspace";
import { transportForHost } from "./client";
import {
  ComputerHostInUseError,
  createHost,
  deleteHost,
  getHost,
  type HostView,
  listHosts,
  MissingComputerKeyError,
  setHostStatus,
  toHostView,
  touchHostSeen,
  updateHost,
} from "./hosts";
import { type PingResult, ping } from "./remote-client";
import {
  COMPUTER_HOST_KINDS,
  type ComputerHost,
  type ComputerHostConfig,
  type ComputerHostKind,
} from "./schema";

/**
 * `/api/w/:workspaceSlug/computer-hosts` - where an agent's computer may run.
 *
 * Members may list, owners may change: a host is a machine somebody pays for
 * and a credential somebody issued, which puts it with the other settings
 * screens rather than with the agents. Neither the daemon token nor the Fly
 * API token is ever in a response - the self-hosted daemon token appears once,
 * at creation or rotation, and after that only its hash exists here.
 */

const CONFLICT = 409;
const SERVICE_UNAVAILABLE = 503;
const NAME_MAX_LENGTH = 120;
const FLY_APP_MAX_LENGTH = 120;
const FLY_TOKEN_MAX_LENGTH = 8192;
const MAX_VOLUME_GB = 500;
const MAX_CPUS = 16;
const MAX_MEMORY_MB = 65_536;

/**
 * "Does this Fly API token work, and does it reach that app?" - one
 * authenticated GET, the cheapest question the Machines API answers.
 *
 * A function rather than a `fetch` inline so the routes can be exercised with
 * no network at all: there is no Fly account behind this yet, and the tests
 * must never depend on one.
 */
export type FlyProbe = (input: {
  app: string;
  token: string;
}) => Promise<boolean>;

const FLY_API_BASE = "https://api.machines.dev/v1";

/**
 * Fail closed, and say nothing about why: an error body from Fly can quote the
 * request it was made with, and that request carries the token.
 */
const liveFlyProbe: FlyProbe = async ({ app, token }) => {
  try {
    const response = await fetch(
      `${FLY_API_BASE}/apps/${encodeURIComponent(app)}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    return response.ok;
  } catch {
    return false;
  }
};

export interface HostRouteDeps {
  flyProbe: FlyProbe;
  transportFor: typeof transportForHost;
}

const isPositiveIntWithin = (value: unknown, max: number): boolean =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= max;

const parseInstance = (value: unknown): ComputerHostConfig["instance"] => {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest('"config.instance" must be an object.');
  }
  const { cpus, memory_mb } = value as Record<string, unknown>;
  if (cpus !== undefined && !isPositiveIntWithin(cpus, MAX_CPUS)) {
    throw badRequest(
      `"config.instance.cpus" must be a whole number of CPUs, at most ${MAX_CPUS}.`
    );
  }
  if (
    memory_mb !== undefined &&
    !isPositiveIntWithin(memory_mb, MAX_MEMORY_MB)
  ) {
    throw badRequest(
      `"config.instance.memory_mb" must be a whole number of megabytes, at most ${MAX_MEMORY_MB}.`
    );
  }
  return {
    ...(cpus === undefined ? {} : { cpus: cpus as number }),
    ...(memory_mb === undefined ? {} : { memory_mb: memory_mb as number }),
  };
};

/**
 * A Fly host is an app the user already created (we never create one: that
 * needs an org-scoped token), so `app` is the one thing we cannot do without.
 * A self-hosted host has nothing to configure - the container is the user's.
 */
const parseConfig = (
  body: Record<string, unknown>,
  kind: ComputerHostKind
): ComputerHostConfig => {
  const raw = body.config;
  if (raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    throw badRequest('"config" must be an object.');
  }
  if (kind === "self_hosted") {
    return {};
  }

  const config = (raw ?? {}) as Record<string, unknown>;
  const app = requireString(config, "app", { maxLength: FLY_APP_MAX_LENGTH });
  if (
    config.volume_gb !== undefined &&
    !isPositiveIntWithin(config.volume_gb, MAX_VOLUME_GB)
  ) {
    throw badRequest(
      `"config.volume_gb" must be a whole number of gigabytes, at most ${MAX_VOLUME_GB}.`
    );
  }
  return {
    app,
    ...(config.image === undefined
      ? {}
      : { image: requireString(config, "image") }),
    ...(config.region === undefined
      ? {}
      : { region: requireString(config, "region") }),
    ...(config.volume_gb === undefined
      ? {}
      : { volume_gb: config.volume_gb as number }),
    ...(parseInstance(config.instance) === undefined
      ? {}
      : { instance: parseInstance(config.instance) }),
  };
};

/** Fly's token, and only Fly's: a self-hosted host has no API to call. */
const parseFlyApiToken = (
  body: Record<string, unknown>,
  kind: ComputerHostKind
): string | undefined => {
  const token = optionalString(body, "flyApiToken", {
    maxLength: FLY_TOKEN_MAX_LENGTH,
  });
  if (token && kind !== "fly") {
    throw badRequest('"flyApiToken" applies to Fly hosts only.');
  }
  return token || undefined;
};

/**
 * The token is checked before it is stored, and a rejection says nothing
 * beyond "it did not work" - the same stance the workspace Anthropic key
 * takes, for the same reason.
 */
const requireWorkingFlyToken = async (
  probe: FlyProbe,
  app: string,
  token: string
): Promise<void> => {
  if (!(await probe({ app, token }))) {
    throw badRequest(
      `That Fly API token could not read the app "${app}". Check the token and the app name, then try again.`
    );
  }
};

const viewOf = async (
  c: Context<ApiEnv>,
  host: ComputerHost
): Promise<HostView> =>
  toHostView(
    host,
    await listAgentIdsForComputerHost(createDb(c.env.DB), host.id)
  );

const requireHost = async (
  c: Context<ApiEnv>,
  id: string
): Promise<ComputerHost> => {
  const host = await getHost(createDb(c.env.DB), c.get("workspace").id, id);
  if (!host) {
    throw notFound("Computer host not found.");
  }
  return host;
};

/** A deployment with no `CONNECTOR_KEY` cannot hold a Fly host's secrets. */
const asHttpError = (c: Context<ApiEnv>, error: unknown): Response => {
  if (error instanceof MissingComputerKeyError) {
    return c.json({ error: error.message }, SERVICE_UNAVAILABLE);
  }
  if (error instanceof ComputerHostInUseError) {
    return c.json({ error: error.message }, CONFLICT);
  }
  throw error;
};

/**
 * A real `ping` through the host's own transport. A transport that cannot even
 * be built - a missing key, a host with no token stored - is a configuration
 * failure rather than a connection one, but both are the owner's to fix, so
 * both come back as the same refusal.
 */
const pingHost = async (
  db: Db,
  env: Env,
  host: ComputerHost,
  transportFor: typeof transportForHost
): Promise<PingResult> => {
  try {
    return await ping(await transportFor(db, env, host, null));
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The test failed.",
    };
  }
};

export const createComputerHostRoutes = (
  deps: Partial<HostRouteDeps> = {}
): Hono<ApiEnv> => {
  const flyProbe = deps.flyProbe ?? liveFlyProbe;
  const transportFor = deps.transportFor ?? transportForHost;

  const routes = new Hono<ApiEnv>();
  routes.use("*", requireAuth);

  routes.get("/", async (c) => {
    const hosts = await listHosts(createDb(c.env.DB), c.get("workspace").id);
    return c.json({
      hosts: hosts.map(({ agentIds, host }) => toHostView(host, agentIds)),
    });
  });

  routes.post("/", requireOwner, async (c) => {
    const body = await readJsonObject(c.req.raw);
    const kind = requireEnum(body, "kind", COMPUTER_HOST_KINDS);
    const input = {
      config: parseConfig(body, kind),
      flyApiToken: parseFlyApiToken(body, kind),
      kind,
      name: requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    };

    if (kind === "fly") {
      if (!input.flyApiToken) {
        throw badRequest('"flyApiToken" is required for a Fly host.');
      }
      // Before the network call: with no key the token could not be stored
      // even if Fly accepted it.
      if (!c.env.CONNECTOR_KEY) {
        return c.json(
          { error: new MissingComputerKeyError().message },
          SERVICE_UNAVAILABLE
        );
      }
      await requireWorkingFlyToken(
        flyProbe,
        input.config.app ?? "",
        input.flyApiToken
      );
    }

    try {
      const { host, token } = await createHost(
        createDb(c.env.DB),
        c.env,
        c.get("workspace").id,
        input
      );
      // `token` is the plaintext daemon token, and this is the only response
      // it ever appears in - and only for a self-hosted host, whose daemon is
      // the side that presents it. It is null for Fly.
      return c.json({ host: await viewOf(c, host), token }, 201);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return c.json(
          { error: `A computer host named "${input.name}" already exists.` },
          CONFLICT
        );
      }
      return asHttpError(c, error);
    }
  });

  routes.patch("/:id", requireOwner, async (c) => {
    const body = await readJsonObject(c.req.raw);
    const existing = await requireHost(c, c.req.param("id"));
    if (body.kind !== undefined && body.kind !== existing.kind) {
      throw badRequest(
        '"kind" is fixed when a host is created. Add a new host instead.'
      );
    }

    const input = {
      config:
        body.config === undefined
          ? undefined
          : parseConfig(body, existing.kind),
      flyApiToken: parseFlyApiToken(body, existing.kind),
      name: optionalString(body, "name", { maxLength: NAME_MAX_LENGTH }),
      rotateToken: optionalBoolean(body, "rotateToken"),
    };

    try {
      const updated = await updateHost(
        createDb(c.env.DB),
        c.env,
        c.get("workspace").id,
        existing.id,
        input
      );
      if (!updated) {
        throw notFound("Computer host not found.");
      }
      // A rotation shows the new self-hosted token once, exactly as creation
      // did; every other edit answers with `token: null`.
      return c.json({
        host: await viewOf(c, updated.host),
        token: updated.token,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return c.json(
          { error: `A computer host named "${input.name}" already exists.` },
          CONFLICT
        );
      }
      return asHttpError(c, error);
    }
  });

  routes.delete("/:id", requireOwner, async (c) => {
    const host = await requireHost(c, c.req.param("id"));
    try {
      await deleteHost(createDb(c.env.DB), c.get("workspace").id, host.id);
    } catch (error) {
      return asHttpError(c, error);
    }
    return c.body(null, 204);
  });

  /**
   * "Is anything there?" - the answer becomes the host's status: a host that
   * answers is `ready` and was seen just now, one that does not carries the
   * reason it gave. No machine id, because this asks the host rather than one
   * agent's computer, so on Fly the proxy picks any machine in the app.
   */
  routes.post("/:id/test", requireOwner, async (c) => {
    const db = createDb(c.env.DB);
    const host = await requireHost(c, c.req.param("id"));
    const result = await pingHost(db, c.env, host, transportFor);

    if (result.ok) {
      await setHostStatus(db, host.id, "ready");
      await touchHostSeen(db, host.id);
      return c.json({
        hostname: result.hostname,
        ok: true,
        version: result.version,
      });
    }

    await setHostStatus(db, host.id, "error", result.reason);
    return c.json({ ok: false, reason: result.reason });
  });

  return routes;
};

/** The router the server mounts; the factory above is what tests reach for. */
export const computerHostRoutes = createComputerHostRoutes();
