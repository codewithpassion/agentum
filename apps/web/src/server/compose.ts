// The composition root. It builds every service from the Worker's bindings and
// secrets, once per request (and once per minute tick). Kept free of Clerk and
// `cloudflare:workers` imports so bun can test it: callers pass `env` in.
//
// Lanes extend the app from here with one factory call each: add an adapter to
// `adapters` or a gateway to `gateways` below. Nothing else needs to know.
import type { Database } from "@repo/db";
import { type Atomic, d1Atomic } from "@repo/db/atomic";
import { type AgentsService, createAgentsService } from "@repo/services/agents";
import {
  type ApiKeysService,
  createApiKeysService,
} from "@repo/services/api-keys";
import {
  type ConnectorOAuthService,
  createConnectorOAuthService,
} from "@repo/services/connector-oauth";
import {
  type ConnectorsService,
  createConnectorsService,
} from "@repo/services/connectors";
import type { Fetcher } from "@repo/services/connectors/mcp";
import {
  type CredentialsService,
  createCredentialsService,
} from "@repo/services/credentials";
import {
  type Blobs,
  createEventsService,
  type EventsService,
} from "@repo/services/events";
import {
  createFilesService,
  type FileBlobs,
  type FilesService,
} from "@repo/services/files";
import { createInboxService, type InboxService } from "@repo/services/inbox";
import {
  createMachinesService,
  type MachinesService,
} from "@repo/services/machines";
import { createMachineRuntime } from "@repo/services/machines/runtime";
import type { MachineRelayPort } from "@repo/services/machines/types";
import {
  createOAuthClientsService,
  type OAuthClientsService,
} from "@repo/services/oauth-clients";
import {
  createRoutinesService,
  type RoutinesService,
} from "@repo/services/routines";
import { createRunsService, type RunsService } from "@repo/services/runs";
import {
  type Clock,
  type Gateway,
  type RuntimeAdapter,
  systemClock,
} from "@repo/services/runs/types";
import {
  createSessionsService,
  type SessionsService,
} from "@repo/services/sessions";
import {
  createSlackService,
  type SlackDirectory,
  type SlackService,
} from "@repo/services/slack";
import { createSlackGateway } from "@repo/services/slack/gateway";
import {
  createSlackAppsService,
  type SlackAppsService,
} from "@repo/services/slack-apps";
import {
  createTriggersService,
  type TriggersService,
} from "@repo/services/triggers";
import { createWorkspacesService } from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/d1";
import { r2Blobs } from "./r2-blobs.ts";
import { r2FileBlobs } from "./r2-files.ts";
import { durableRelayPort } from "./relay-port.ts";
import { clerkSlackDirectory } from "./slack-directory.ts";

/** What the runs service needs besides a database. */
export interface Infra {
  atomic: Atomic;
  blobs: Blobs;
  clock: Clock;
  devFakeRuntime: boolean;
  /** How connector probes reach the network. Defaults to the global `fetch`. */
  fetch?: Fetcher;
  /** Where uploaded files live: R2 in the app. */
  fileBlobs: FileBlobs;
  /** `PUBLIC_BASE_URL`. A Connect path posted to Slack becomes a link under it. */
  publicBaseUrl?: string;
  relay: MachineRelayPort;
  /** `RUN_TOKEN_KEY`. Machine claims mint run tokens with it. */
  runTokenKey?: string;
  /** `SECRETS_KEY`. Storing a connector credential encrypts with it. */
  secretsKey?: string;
  /** Finds the Clerk user behind a Slack email. Without one, nobody is linked. */
  slackDirectory?: SlackDirectory;
}

export interface Services {
  agents: AgentsService;
  apiKeys: ApiKeysService;
  connectorOAuth: ConnectorOAuthService;
  connectors: ConnectorsService;
  credentials: CredentialsService;
  events: EventsService;
  files: FilesService;
  inbox: InboxService;
  machines: MachinesService;
  oauthClients: OAuthClientsService;
  routines: RoutinesService;
  runs: RunsService;
  sessions: SessionsService;
  slack: SlackService;
  slackApps: SlackAppsService;
  triggers: TriggersService;
  workspaces: ReturnType<typeof createWorkspacesService>;
}

export interface Composed {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  services: Services;
}

/** The bindings and secrets `compose` reads. */
export type ComposeEnv = Pick<
  Env,
  | "ALLOWED_ORG_IDS"
  | "CLERK_SECRET_KEY"
  | "DB"
  | "FILES"
  | "MACHINE_RELAY"
  | "PUBLIC_BASE_URL"
  | "RUN_TOKEN_KEY"
  | "SECRETS_KEY"
>;

/** Splits a comma separated list of ids, trimmed, dropping empty entries. */
export const parseOrgIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/** A directory that knows nobody: every unknown Slack sender stays unlinked. */
const unlinkedDirectory: SlackDirectory = {
  findUserIdByEmail: () => Promise.resolve(null),
  isOrgMember: () => Promise.resolve(false),
};

/** The services over a database and infra. Tests call this with fakes. */
export const composeWith = ({
  allowedOrgIds,
  db,
  infra,
}: {
  allowedOrgIds: readonly string[];
  db: Database;
  infra: Infra;
}): Composed => {
  // Lanes register here, by injection.
  const adapters: RuntimeAdapter[] = [
    createMachineRuntime({ relay: infra.relay }),
  ];

  const workspaces = createWorkspacesService({ allowedOrgIds, db });
  const events = createEventsService({ blobs: infra.blobs, db });
  const agents = createAgentsService({ db, events });
  const apiKeys = createApiKeysService({ clock: infra.clock, db, events });
  // A bare `fetch` loses its receiver in workerd ("Illegal invocation").
  const connectorFetch: Fetcher =
    infra.fetch ?? ((input, init) => fetch(input, init));
  const connectors = createConnectorsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const connectorOAuth = createConnectorOAuthService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const credentials = createCredentialsService({
    clock: infra.clock,
    db,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const files = createFilesService({
    blobs: infra.fileBlobs,
    clock: infra.clock,
    db,
  });
  // The runs service takes this gateway, and the inbox starts runs through the
  // runs service, so it reaches `runs` lazily.
  const inbox = createInboxService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    runs: { startRun: (principal, input) => runs.startRun(principal, input) },
  });
  const machines = createMachinesService({
    allowedOrgIds,
    clock: infra.clock,
    db,
    events,
    relay: infra.relay,
  });
  const oauthClients = createOAuthClientsService({ clock: infra.clock, db });
  const slackGateway = createSlackGateway({
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    files,
    publicBaseUrl: infra.publicBaseUrl,
    secretsKey: infra.secretsKey,
  });
  // A connector that needs a login tells the person in Slack, privately.
  events.onAppend(slackGateway.notifyNeedsAuth);
  const gateways: Gateway[] = [inbox.gateway, slackGateway];
  const runs = createRunsService({
    adapters,
    atomic: infra.atomic,
    blobs: infra.blobs,
    clock: infra.clock,
    db,
    devFakeRuntime: infra.devFakeRuntime,
    gateways,
    runTokenKey: infra.runTokenKey,
  });
  const routines = createRoutinesService({
    allowedOrgIds,
    clock: infra.clock,
    db,
    events,
    runs,
  });
  const sessions = createSessionsService({ db, events });
  const slack = createSlackService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    directory: infra.slackDirectory ?? unlinkedDirectory,
    events,
    fetch: connectorFetch,
    runs,
    secretsKey: infra.secretsKey,
  });
  const slackApps = createSlackAppsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    publicBaseUrl: infra.publicBaseUrl,
    secretsKey: infra.secretsKey,
  });
  const triggers = createTriggersService({
    allowedOrgIds,
    clock: infra.clock,
    db,
    events,
    runs,
  });
  return {
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    services: {
      agents,
      apiKeys,
      connectorOAuth,
      connectors,
      credentials,
      events,
      files,
      inbox,
      machines,
      oauthClients,
      routines,
      runs,
      sessions,
      slack,
      slackApps,
      triggers,
      workspaces,
    },
  };
};

/**
 * The app's services on D1 and R2. The fake runtime is on in dev builds only,
 * so the caller passes `import.meta.env.DEV`.
 */
export const compose = (env: ComposeEnv, devFakeRuntime: boolean): Composed => {
  const db = drizzle(env.DB);
  return composeWith({
    allowedOrgIds: parseOrgIds(env.ALLOWED_ORG_IDS),
    db,
    infra: {
      atomic: d1Atomic(db),
      blobs: r2Blobs(env.FILES),
      clock: systemClock,
      devFakeRuntime,
      fileBlobs: r2FileBlobs(env.FILES),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      relay: durableRelayPort(env.MACHINE_RELAY),
      runTokenKey: env.RUN_TOKEN_KEY,
      secretsKey: env.SECRETS_KEY,
      slackDirectory: clerkSlackDirectory(env.CLERK_SECRET_KEY),
    },
  });
};
