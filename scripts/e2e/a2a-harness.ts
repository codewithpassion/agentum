// What the A2A interop scripts share: a `vite dev` deployment with its own
// database, a person who acts through the real tRPC routes, and a JSON-RPC
// client. The scripts under `scripts/e2e/a2a-*.ts` run from the repo root.
//
// A deployment is a real `vite dev` Worker (workerd, D1, Durable Objects) with
// its own `.wrangler` state (`HM_STATE_DIR`, read by `apps/web/vite.config.ts`)
// and its own `PUBLIC_BASE_URL`, passed through the process environment
// (`CLOUDFLARE_INCLUDE_PROCESS_ENV`). Its agents use the dev-only `faux` model,
// so no model key is involved.
//
// The person is the dev user of the Clerk dev instance in `apps/web/.env.local`.
// A Clerk session made through the backend API gives a token that carries the
// user's organisation, and the app accepts it as a bearer, so every call a
// person makes in the browser can be made over HTTP here without a browser.
import { Database } from "bun:sqlite";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const WEB_DIR = join(REPO_ROOT, "apps", "web");
const ENV_FILE = join(WEB_DIR, ".env.local");
const CLERK_API = "https://api.clerk.com/v1";
const SERVER_TIMEOUT_MS = 180_000;
const PORT_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const TOKEN_TTL_MARGIN_MS = 20_000;
const LINE = /^([A-Z0-9_]+)=(.*)$/;
const QUOTED = /^"(.*)"$/;

/** What a deployment's person is until `start` has signed one in. */
const NOT_SIGNED_IN: Person = {
  close: () => Promise.resolve(),
  mutate: () => Promise.reject(new Error("The deployment is not started.")),
  query: () => Promise.reject(new Error("The deployment is not started.")),
};

/** Something went wrong that the person running the script can act on. */
export class E2eError extends Error {}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The default work folder: scratch files, logs and databases live here. */
export const defaultWorkDir = (): string =>
  process.env.A2A_E2E_DIR ?? join(tmpdir(), "harbourmaster-a2a-e2e");

/** `KEY=value` lines of `apps/web/.env.local`. */
export const readEnvLocal = (): Record<string, string> => {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch (error) {
    throw new E2eError(
      `${ENV_FILE} is missing. Run \`bun run create-dev-user\` in apps/web first.`,
      { cause: error }
    );
  }
  for (const line of text.split("\n")) {
    const match = LINE.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out[match[1]] = match[2].replace(QUOTED, "$1");
    }
  }
  return out;
};

/** A port nothing listens on right now. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new E2eError("no free port"))
      );
    });
  });

/** Polls `done` until it is true, or throws with `label` after `timeoutMs`. */
export const waitUntil = async (
  label: string,
  timeoutMs: number,
  done: () => Promise<boolean> | boolean,
  pollMs = POLL_MS
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: Polling is sequential.
    if (await done()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new E2eError(`${label} timed out after ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
};

// ---------------------------------------------------------------------------
// The person

export class TrpcError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(
    path: string,
    status: number,
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(`${path} answered ${status} ${code}: ${message}`, options);
    this.code = code;
    this.status = status;
  }
}

export interface Person {
  /** Revokes the Clerk session this person used. */
  close: () => Promise<void>;
  mutate: <T = unknown>(path: string, input: unknown) => Promise<T>;
  query: <T = unknown>(path: string, input?: unknown) => Promise<T>;
}

const clerkJson = async (
  secretKey: string,
  path: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new E2eError(
      `Clerk ${path} answered ${response.status}: ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  return body;
};

/**
 * A signed-in person for a deployment: the dev user, in the dev organisation,
 * with a session made through Clerk's backend API. Tokens live a minute, so
 * each call asks for a fresh one.
 */
export const createPerson = async (origin: string): Promise<Person> => {
  const env = readEnvLocal();
  const secretKey = env.CLERK_SECRET_KEY;
  const email = env.DEV_LOGIN_EMAIL;
  if (!(secretKey && email)) {
    throw new E2eError(
      "CLERK_SECRET_KEY and DEV_LOGIN_EMAIL must be set in apps/web/.env.local"
    );
  }
  const users = (await clerkJson(
    secretKey,
    `/users?email_address=${encodeURIComponent(email)}`
  )) as unknown as { id: string }[];
  const userId = users[0]?.id;
  if (!userId) {
    throw new E2eError(
      `No Clerk user for ${email}. Run \`bun run create-dev-user\` in apps/web.`
    );
  }
  const session = (await clerkJson(secretKey, "/sessions", {
    body: JSON.stringify({ user_id: userId }),
    method: "POST",
  })) as { id: string };
  let cached: { expires: number; jwt: string } | undefined;
  const token = async (): Promise<string> => {
    if (cached && cached.expires > Date.now()) {
      return cached.jwt;
    }
    const made = (await clerkJson(secretKey, `/sessions/${session.id}/tokens`, {
      body: "{}",
      method: "POST",
    })) as { jwt: string };
    cached = {
      expires: Date.now() + TOKEN_TTL_MARGIN_MS,
      jwt: made.jwt,
    };
    return made.jwt;
  };

  const unwrap = async <T>(path: string, response: Response): Promise<T> => {
    const text = await response.text();
    let body: {
      error?: { data?: { code?: string }; message?: string };
      result?: { data: T };
    };
    try {
      body = JSON.parse(text);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: The cause is the last argument of TrpcError.
      throw new TrpcError(
        path,
        response.status,
        "NOT_JSON",
        text.slice(0, 200),
        { cause: error }
      );
    }
    if (body.error || !body.result) {
      throw new TrpcError(
        path,
        response.status,
        body.error?.data?.code ?? "UNKNOWN",
        body.error?.message ?? text.slice(0, 200)
      );
    }
    return body.result.data;
  };

  return {
    close: async () => {
      await clerkJson(secretKey, `/sessions/${session.id}/revoke`, {
        body: "{}",
        method: "POST",
      }).catch(() => undefined);
    },
    mutate: async <T>(path: string, input: unknown) =>
      await unwrap<T>(
        path,
        await fetch(`${origin}/api/trpc/${path}`, {
          body: JSON.stringify(input),
          headers: {
            Authorization: `Bearer ${await token()}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      ),
    query: async <T>(path: string, input: unknown = {}) =>
      await unwrap<T>(
        path,
        await fetch(
          `${origin}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
          { headers: { Authorization: `Bearer ${await token()}` } }
        )
      ),
  };
};

// ---------------------------------------------------------------------------
// A deployment

export interface DeploymentOptions {
  /** Extra environment for the Worker, such as a secret a check needs. */
  env?: Record<string, string>;
  name: string;
  port: number;
  workDir: string;
}

export interface Deployment {
  logFile: string;
  name: string;
  origin: string;
  /** The person, signed in to this deployment. Set by `start`. */
  person: Person;
  port: number;
  start: () => Promise<void>;
  stateDir: string;
  stop: () => Promise<void>;
  /** Runs the minute tick once, as the cron trigger would. */
  tick: () => Promise<void>;
}

const runLogged = async (
  cmd: string[],
  cwd: string,
  logFile: string
): Promise<number> => {
  const fd = openSync(logFile, "a");
  try {
    const proc = spawn(cmd, { cwd, stderr: fd, stdout: fd });
    return await proc.exited;
  } finally {
    closeSync(fd);
  }
};

/** A `vite dev` Worker with its own state folder. Call `start`, then `stop` in a `finally`. */
export const createDeployment = (options: DeploymentOptions): Deployment => {
  const { name, port, workDir } = options;
  const origin = `http://localhost:${port}`;
  const dir = join(workDir, name);
  const stateDir = join(dir, "state");
  const logFile = join(dir, "vite.log");
  let child: Subprocess | undefined;
  let logFd: number | undefined;

  const answers = (): Promise<boolean> =>
    fetch(`${origin}/api/dev/atomic-probe`).then(
      (response) => response.ok,
      () => false
    );

  const deployment: Deployment = {
    logFile,
    name,
    origin,
    person: NOT_SIGNED_IN,
    port,
    start: async () => {
      if (await answers()) {
        throw new E2eError(
          `${origin} already answers. Stop that process first, the script stops only what it starts.`
        );
      }
      mkdirSync(stateDir, { recursive: true });
      const migrated = await runLogged(
        [
          "bunx",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--persist-to",
          stateDir,
        ],
        WEB_DIR,
        join(dir, "migrate.log")
      );
      if (migrated !== 0) {
        throw new E2eError(
          `wrangler d1 migrations apply failed. See ${join(dir, "migrate.log")}`
        );
      }
      logFd = openSync(logFile, "a");
      const proc = spawn(
        ["bunx", "vite", "dev", "--port", String(port), "--strictPort"],
        {
          cwd: WEB_DIR,
          detached: true,
          env: {
            ...process.env,
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
            HM_STATE_DIR: stateDir,
            PUBLIC_BASE_URL: origin,
            ...options.env,
          },
          stderr: logFd,
          stdout: logFd,
        }
      );
      child = proc;
      await waitUntil(`${name} starting`, SERVER_TIMEOUT_MS, () => {
        if (proc.exitCode !== null) {
          throw new E2eError(
            `vite dev for ${name} exited with ${proc.exitCode}. See ${logFile}`
          );
        }
        return answers();
      });
      deployment.person = await createPerson(origin);
    },
    stateDir,
    stop: async () => {
      await deployment.person.close();
      const proc = child;
      child = undefined;
      if (proc) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // The group already exited.
        }
        await proc.exited;
        await waitUntil(
          `${name} going down`,
          PORT_TIMEOUT_MS,
          async () => !(await answers())
        );
      }
      if (logFd !== undefined) {
        closeSync(logFd);
        logFd = undefined;
      }
    },
    tick: async () => {
      const response = await fetch(
        `${origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`
      );
      if (!response.ok) {
        throw new E2eError(`${name} tick answered ${response.status}`);
      }
    },
  };
  mkdirSync(dir, { recursive: true });
  return deployment;
};

/**
 * A deployment that is already running, for working on a script. Nothing is
 * started or stopped, and the person still signs in with a fresh session.
 */
export const attachDeployment = (origin: string, stateDir = ""): Deployment => {
  const url = new URL(origin);
  const deployment: Deployment = {
    logFile: "",
    name: "attached",
    origin: url.origin,
    person: NOT_SIGNED_IN,
    port: Number(url.port),
    start: async () => {
      deployment.person = await createPerson(url.origin);
    },
    stateDir,
    stop: async () => {
      await deployment.person.close();
    },
    tick: async () => {
      await fetch(
        `${url.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`
      );
    },
  };
  return deployment;
};

// ---------------------------------------------------------------------------
// Agents and connections, through the person

export interface PublishedAgent {
  agentId: string;
  cardUrl: string;
  publicId: string;
}

export interface AccessKey {
  cardUrl: string;
  connectionId: string;
  token: string;
}

const SKILLS = [
  {
    description: "Answers questions.",
    id: "ask",
    name: "Ask",
    tags: ["e2e"],
  },
];

/** Makes a cloud agent on the `faux` model and publishes it. */
export const publishAgent = async (
  person: Person,
  name: string
): Promise<PublishedAgent> => {
  const slug = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const agent = await person.mutate<{ id: string }>("agents.create", {
    instructions: "Answer from the script.",
    model: "faux",
    name,
    runtime: "cloud",
    slug,
  });
  const card = await person.mutate<{ cardUrl: string; publicId: string }>(
    "a2a.publish",
    {
      agentId: agent.id,
      description: `${name} answers questions.`,
      skills: SKILLS,
    }
  );
  return { agentId: agent.id, cardUrl: card.cardUrl, publicId: card.publicId };
};

/** A key for an outside client, with the inbound policy and the hourly limit it needs. */
export const giveKey = async (
  person: Person,
  agent: PublishedAgent,
  label: string,
  policies: {
    hourlyLimit?: number;
    inboundPolicy?: "approve" | "auto";
    toolPolicy?: "agent_rules" | "ask";
  } = {}
): Promise<AccessKey> => {
  const key = await person.mutate<{
    cardUrl: string;
    connection: { id: string };
    token: string;
  }>("a2a.createAccessKey", { agentId: agent.agentId, label });
  if (Object.keys(policies).length > 0) {
    await person.mutate("a2a.setPolicies", {
      connectionId: key.connection.id,
      ...policies,
    });
  }
  return {
    cardUrl: key.cardUrl,
    connectionId: key.connection.id,
    token: key.token,
  };
};

// ---------------------------------------------------------------------------
// JSON-RPC

export interface RpcAnswer {
  body: { error?: { code: number; message: string }; result?: unknown };
  status: number;
}

/** One JSON-RPC call to a published agent, as an outside client makes it. */
export const rpc = async (
  origin: string,
  publicId: string,
  token: string | null,
  method: string,
  params: unknown = {}
): Promise<RpcAnswer> => {
  const response = await fetch(`${origin}/a2a/${publicId}/rpc`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: {
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
};

/** A plain text user message, the way an outside client sends one. */
export const textMessage = (
  text: string,
  options: { contextId?: string; messageId?: string } = {}
) => ({
  message: {
    ...(options.contextId === undefined
      ? {}
      : { contextId: options.contextId }),
    messageId: options.messageId ?? crypto.randomUUID(),
    parts: [{ text }],
    role: "ROLE_USER",
  },
});

// ---------------------------------------------------------------------------
// The database, read only

/**
 * A deployment's local D1 database, opened read only, for checks that need the
 * state no route shows (the text of an outbound task, the runs of a session).
 * The caller closes it.
 */
export const openDatabase = (deployment: Deployment): Database => {
  if (deployment.stateDir === "") {
    throw new E2eError(`${deployment.name} has no state folder to read`);
  }
  const dir = join(
    deployment.stateDir,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject"
  );
  const file = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(dir, name))
    .at(0);
  if (!file) {
    throw new E2eError(`no database in ${dir}`);
  }
  return new Database(file, { readonly: true });
};

/** One query on a deployment's database, then close it. */
export const queryRows = <T>(
  deployment: Deployment,
  sql: string,
  ...params: (number | string)[]
): T[] => {
  const db = openDatabase(deployment);
  try {
    return db.query<T, (number | string)[]>(sql).all(...params);
  } finally {
    db.close();
  }
};
