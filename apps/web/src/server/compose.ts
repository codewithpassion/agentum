// The composition root. It builds every service from the Worker's bindings and
// secrets, once per request (and once per minute tick). Kept free of Clerk and
// `cloudflare:workers` imports so bun can test it: callers pass `env` in.
//
// Lanes extend the app from here with one factory call each: add an adapter to
// `adapters` or a gateway to `gateways` below. Nothing else needs to know.
import type { Database } from "@repo/db";
import { type Atomic, d1Atomic } from "@repo/db/atomic";
import type { ModelProvider } from "@repo/db/shared";
import { type AgentsService, createAgentsService } from "@repo/services/agents";
import {
  type ApiKeysService,
  createApiKeysService,
} from "@repo/services/api-keys";
import { createCloudRuntime } from "@repo/services/cloud/runtime";
import type { CloudRunnerPort } from "@repo/services/cloud/types";
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
  type PeopleLookup,
} from "@repo/services/events";
import {
  createFilesService,
  type FileBlobs,
  type FilesService,
} from "@repo/services/files";
import { createInboxService, type InboxService } from "@repo/services/inbox";
import {
  createLibraryService,
  type LibraryBlobs,
  type LibraryService,
} from "@repo/services/library";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import {
  createLibraryLinksService,
  type LibraryLinksService,
} from "@repo/services/library-links";
import {
  createMachinesService,
  type MachinesService,
} from "@repo/services/machines";
import { createMachineRuntime } from "@repo/services/machines/runtime";
import type { MachineRelayPort } from "@repo/services/machines/types";
import { ENVIRONMENT_NAME } from "@repo/services/managed/config";
import {
  connectManagedGateway,
  validateAnthropicKey,
} from "@repo/services/managed/gateway";
import {
  createManagedKeysService,
  type ManagedKeysService,
} from "@repo/services/managed/keys";
import { createManagedRuntime } from "@repo/services/managed/runtime";
import {
  createManagedService,
  type ManagedService,
  type ManagedServiceOptions,
} from "@repo/services/managed/service";
import { createManagedSkillsSource } from "@repo/services/managed/skills-source";
import type { ManagedPollerPort } from "@repo/services/managed/types";
import {
  createModelKeysService,
  type ModelKeysService,
  validateModelKey,
} from "@repo/services/model-keys";
import {
  createNetworkService,
  type NetworkService,
} from "@repo/services/network";
import {
  createOAuthClientsService,
  type OAuthClientsService,
} from "@repo/services/oauth-clients";
import {
  createRoutinesService,
  type RoutinesService,
} from "@repo/services/routines";
import {
  createRunSkillsService,
  type RunSkillsService,
} from "@repo/services/run-skills";
import { createRunsService, type RunsService } from "@repo/services/runs";
import {
  type Clock,
  type Gateway,
  type RuntimeAdapter,
  systemClock,
} from "@repo/services/runs/types";
import {
  createSecretsService,
  type SecretsService,
} from "@repo/services/secrets";
import {
  createSessionsService,
  type SessionsService,
} from "@repo/services/sessions";
import { createSkillsService, type SkillsService } from "@repo/services/skills";
import {
  createSkillsStoreService,
  type SkillBlobs,
  type SkillsStoreService,
} from "@repo/services/skills-store";
import { memorySkillBlobs } from "@repo/services/skills-store/memory";
import {
  createSlackService,
  type SlackDirectory,
  type SlackService,
} from "@repo/services/slack";
import { createSlackGateway } from "@repo/services/slack/gateway";
import {
  createDbStatusPorts,
  createSlackStatus,
} from "@repo/services/slack/status";
import {
  createSlackAppsService,
  type SlackAppsService,
} from "@repo/services/slack-apps";
import {
  createSlackHistoryService,
  type SlackHistoryService,
} from "@repo/services/slack-history";
import {
  createSlackSendService,
  type SlackSendService,
} from "@repo/services/slack-send";
import {
  createTriggersService,
  type TriggersService,
} from "@repo/services/triggers";
import { createWorkspacesService } from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/d1";
import { clerkPeople } from "./clerk-people.ts";
import { durablePollerPort } from "./managed-poller-port.ts";
import { durableRunnerPort } from "./pi-run-port.ts";
import { r2Blobs } from "./r2-blobs.ts";
import { r2FileBlobs } from "./r2-files.ts";
import { r2LibraryBlobs } from "./r2-library.ts";
import { r2SkillBlobs } from "./r2-skills.ts";
import { durableRelayPort } from "./relay-port.ts";
import {
  type SessionStreamPort,
  streamListener,
  streamPublisher,
} from "./session-stream-port.ts";
import { clerkSlackDirectory } from "./slack-directory.ts";

/** What the runs service needs besides a database. */
export interface Infra {
  atomic: Atomic;
  blobs: Blobs;
  clock: Clock;
  /** Starts and stops the work of a cloud run. Without it, `cloud` agents cannot run. */
  cloudRunner?: CloudRunnerPort;
  /** Runs work after the response: `waitUntil` in a request. Without it, work is awaited. */
  defer?: (work: Promise<void>) => void;
  devFakeRuntime: boolean;
  /** How connector probes reach the network. Defaults to the global `fetch`. */
  fetch?: Fetcher;
  /** Where uploaded files live: R2 in the app. */
  fileBlobs: FileBlobs;
  /** Where the workspace library keeps file bytes: R2 in the app. Tests omit it and get an in-memory store. */
  libraryBlobs?: LibraryBlobs;
  /** The Managed Agents gateway on a workspace's key. Without it, managed runs fail their step. */
  managedGatewayFor?: ManagedServiceOptions["gatewayFor"];
  /** Wakes the poller of a managed run. Without it, `managed` agents cannot run. */
  managedPoller?: ManagedPollerPort;
  /** Names the people behind user ids in the Log. Without it, the Log shows ids. */
  people?: PeopleLookup;
  /** `PUBLIC_BASE_URL`. A Connect path posted to Slack becomes a link under it. */
  publicBaseUrl?: string;
  relay: MachineRelayPort;
  /** `RUN_TOKEN_KEY`. Machine claims mint run tokens with it. */
  runTokenKey?: string;
  /** `SECRETS_KEY`. Storing a connector credential or a workspace secret encrypts with it. */
  secretsKey?: string;
  /** Where the skills store keeps file bytes: R2 in the app. Tests omit it and get an in-memory store. */
  skillBlobs?: SkillBlobs;
  /** Finds the Clerk user behind a Slack email. Without one, nobody is linked. */
  slackDirectory?: SlackDirectory;
  /** Where the live frames of a session go: the SessionStream Durable Object in the app. Without it nothing is streamed. */
  streams?: SessionStreamPort;
  /** Asks Anthropic whether a key works. Without it, `managedKeys` checks only the key's shape. */
  validateAnthropicKey?: (apiKey: string) => Promise<boolean>;
  /** Asks the provider whether a key works. Without it, `modelKeys` checks only the key's shape. */
  validateModelKey?: (
    provider: ModelProvider,
    apiKey: string
  ) => Promise<boolean>;
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
  library: LibraryService;
  libraryLinks: LibraryLinksService;
  machines: MachinesService;
  managed: ManagedService;
  managedKeys: ManagedKeysService;
  modelKeys: ModelKeysService;
  network: NetworkService;
  oauthClients: OAuthClientsService;
  routines: RoutinesService;
  runSkills: RunSkillsService;
  runs: RunsService;
  secrets: SecretsService;
  sessions: SessionsService;
  skills: SkillsService;
  skillsStore: SkillsStoreService;
  slack: SlackService;
  slackApps: SlackAppsService;
  slackHistory: SlackHistoryService;
  slackSend: SlackSendService;
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
  | "MANAGED_POLLER"
  | "PI_RUN"
  | "PUBLIC_BASE_URL"
  | "RUN_TOKEN_KEY"
  | "SECRETS_KEY"
  | "SESSION_STREAM"
>;

/** Splits a comma separated list of ids, trimmed, dropping empty entries. */
export const parseOrgIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

const noGateway: ManagedServiceOptions["gatewayFor"] = () => {
  throw new Error("No Managed Agents gateway is configured.");
};

const noopPoller: ManagedPollerPort = {
  cancel: () => Promise.resolve(),
  kick: () => Promise.resolve(),
};

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
    ...(infra.managedPoller
      ? [
          createManagedRuntime({
            // `managed` is built below, after `runs`, which needs this list.
            abandon: (run) => managed.abandon(run),
            poller: infra.managedPoller,
          }),
        ]
      : []),
    ...(infra.cloudRunner && infra.runTokenKey && infra.publicBaseUrl
      ? [
          createCloudRuntime({
            platformUrl: infra.publicBaseUrl,
            runner: infra.cloudRunner,
            runTokenKey: infra.runTokenKey,
          }),
        ]
      : []),
  ];

  const workspaces = createWorkspacesService({ allowedOrgIds, db });
  const events = createEventsService({
    blobs: infra.blobs,
    db,
    people: infra.people,
  });
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
  const library = createLibraryService({
    atomic: infra.atomic,
    blobs: infra.libraryBlobs ?? memoryLibraryBlobs(),
    clock: infra.clock,
    db,
    events,
  });
  const libraryLinks = createLibraryLinksService({ files, library });
  const skills = createSkillsService({ agents, library });
  const skillsStore = createSkillsStoreService({
    atomic: infra.atomic,
    blobs: infra.skillBlobs ?? memorySkillBlobs(),
    clock: infra.clock,
    db,
    events,
    library,
  });
  const runSkills = createRunSkillsService({ skillsStore });
  const machines = createMachinesService({
    allowedOrgIds,
    clock: infra.clock,
    db,
    events,
    relay: infra.relay,
  });
  const managedKeys = createManagedKeysService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    secretsKey: infra.secretsKey,
    validate: infra.validateAnthropicKey,
  });
  const modelKeys = createModelKeysService({
    clock: infra.clock,
    db,
    secretsKey: infra.secretsKey,
    validate: infra.validateModelKey,
  });
  const network = createNetworkService({ db, events });
  const oauthClients = createOAuthClientsService({ clock: infra.clock, db });
  const secrets = createSecretsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    secretsKey: infra.secretsKey,
  });
  const slackGateway = createSlackGateway({
    clock: infra.clock,
    db,
    defer: infra.defer,
    events,
    fetch: connectorFetch,
    files,
    publicBaseUrl: infra.publicBaseUrl,
    secretsKey: infra.secretsKey,
  });
  // The working status in the thread of a Slack-started run.
  const slackStatus = createSlackStatus({
    clock: infra.clock,
    defer: infra.defer,
    ports: createDbStatusPorts({
      db,
      fetch: connectorFetch,
      secretsKey: infra.secretsKey,
    }),
  });
  // A connector that needs a login tells the person in Slack, privately.
  events.onAppend(slackGateway.notifyNeedsAuth);
  // Catches `slack.delivered`, which the gateway writes through this instance.
  events.onAppend(slackStatus.onEvent);
  const gateways: Gateway[] = [inbox.gateway, slackGateway];
  const runs = createRunsService({
    adapters,
    atomic: infra.atomic,
    blobs: infra.blobs,
    clock: infra.clock,
    db,
    devFakeRuntime: infra.devFakeRuntime,
    gateways,
    library,
    runTokenKey: infra.runTokenKey,
    secrets,
  });
  // Catches the run and tool events the runs service writes through its own events instance.
  runs.onEvent(slackStatus.onEvent);
  if (infra.streams) {
    const onStreamEvent = streamListener(infra.streams);
    events.onAppend(onStreamEvent);
    runs.onEvent(onStreamEvent);
  }
  const managed = createManagedService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    gatewayFor: infra.managedGatewayFor ?? noGateway,
    keys: managedKeys,
    library,
    poller: infra.managedPoller ?? noopPoller,
    publicBaseUrl: infra.publicBaseUrl,
    runs,
    runTokenKey: infra.runTokenKey,
    secrets,
    skills: (run) => createManagedSkillsSource({ runSkills, skillsStore }, run),
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
    status: slackStatus,
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
  const slackSend = createSlackSendService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const slackHistory = createSlackHistoryService({
    db,
    fetch: connectorFetch,
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
      library,
      libraryLinks,
      machines,
      managed,
      managedKeys,
      modelKeys,
      network,
      oauthClients,
      routines,
      runSkills,
      runs,
      secrets,
      sessions,
      skills,
      skillsStore,
      slack,
      slackApps,
      slackHistory,
      slackSend,
      triggers,
      workspaces,
    },
  };
};

/**
 * The app's services on D1 and R2. The fake runtime is on in dev builds only,
 * so the caller passes `import.meta.env.DEV`.
 */
export const compose = (
  env: ComposeEnv,
  devFakeRuntime: boolean,
  defer?: (work: Promise<void>) => void
): Composed => {
  const db = drizzle(env.DB);
  return composeWith({
    allowedOrgIds: parseOrgIds(env.ALLOWED_ORG_IDS),
    db,
    infra: {
      atomic: d1Atomic(db),
      blobs: r2Blobs(env.FILES),
      clock: systemClock,
      cloudRunner: durableRunnerPort(env.PI_RUN),
      defer,
      devFakeRuntime,
      fileBlobs: r2FileBlobs(env.FILES),
      libraryBlobs: r2LibraryBlobs(env.FILES),
      managedGatewayFor: ({ apiKey, environment }) =>
        connectManagedGateway(apiKey, {
          cache: environment,
          environmentName: ENVIRONMENT_NAME,
        }),
      managedPoller: durablePollerPort(env.MANAGED_POLLER),
      people: clerkPeople(env.CLERK_SECRET_KEY),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      relay: durableRelayPort(env.MACHINE_RELAY),
      runTokenKey: env.RUN_TOKEN_KEY,
      secretsKey: env.SECRETS_KEY,
      skillBlobs: r2SkillBlobs(env.FILES),
      slackDirectory: clerkSlackDirectory(env.CLERK_SECRET_KEY),
      streams: streamPublisher(env.SESSION_STREAM, defer),
      validateAnthropicKey,
      validateModelKey,
    },
  });
};
