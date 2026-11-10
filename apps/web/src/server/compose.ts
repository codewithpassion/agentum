import { assistantTools } from "@repo/mcp/assistant";
import type { Product } from "@repo/protocol/releases";
import {
  type AppErrorSlot,
  createArtifactErrorsService,
} from "@repo/services/artifacts/errors";
import {
  type AppReply,
  createAppReplies,
} from "@repo/services/artifacts/replies";
import {
  type AssistantService,
  createAssistantService,
} from "@repo/services/assistant/service";
import {
  createDictationService,
  type DictationService,
} from "@repo/services/dictation";
import {
  type AppWorkerExports,
  appReplyInvoker,
} from "./app-gateway/reply-invoker.ts";
import { createMcpPorts } from "./mcp/ports";
import type { DictationLimits } from "./trpc/dictation-router.ts";
// The composition root. It builds every service from the Worker's bindings and
// secrets, once per request (and once per minute tick). Kept free of Clerk and
// `cloudflare:workers` imports so bun can test it: callers pass `env` in.
//
// Lanes extend the app from here with one factory call each: add an adapter to
// `adapters` or a gateway to `gateways` below. Nothing else needs to know.

import type { A2aFetch } from "@repo/a2a/peer-fetch";
import type { Database } from "@repo/db";
import { type Atomic, d1Atomic } from "@repo/db/atomic";
import type { ModelProvider } from "@repo/db/shared";
import { TRANSFER_HELPER_SOURCE } from "@repo/library-sync/transfer-bundle";
import type { GithubSkillFetcher } from "@repo/protocol/skills";
import {
  type ConnectionsService,
  createConnectionsService,
} from "@repo/services/a2a/connections";
import {
  createOutboundService,
  type OutboundService,
} from "@repo/services/a2a/outbound";
import {
  createOutboxService,
  type OutboxService,
} from "@repo/services/a2a/outbox";
import { createPageReads, type PageReads } from "@repo/services/a2a/page-reads";
import {
  type A2aTasksService,
  createA2aTasksService,
} from "@repo/services/a2a/tasks";
import { type AdminService, createAdminService } from "@repo/services/admin";
import {
  type AgentBuilderService,
  createAgentBuilderService,
} from "@repo/services/agent-builder/service";
import {
  type AgentProfileService,
  createAgentProfileService,
} from "@repo/services/agent-profile";
import { type AgentsService, createAgentsService } from "@repo/services/agents";
import {
  type ApiKeysService,
  createApiKeysService,
} from "@repo/services/api-keys";
import {
  type AppGrantsService,
  createAppGrantsService,
} from "@repo/services/artifacts/app-grants";
import {
  type ArtifactToolPort,
  createArtifactCallsService,
  createConnectorToolCatalog,
  createToolRunner,
  type ToolRunner,
} from "@repo/services/artifacts/calls";
import {
  type ArtifactEndpointsService,
  createArtifactEndpointsService,
} from "@repo/services/artifacts/endpoints";
import {
  type ArtifactGrantsService,
  createArtifactGrantsService,
} from "@repo/services/artifacts/grants";
import {
  type ArtifactPinsService,
  createArtifactPinsService,
} from "@repo/services/artifacts/pins";
import {
  type ArtifactsService,
  createArtifactsService,
} from "@repo/services/artifacts/service";
import {
  type ArtifactSharesService,
  createArtifactSharesService,
} from "@repo/services/artifacts/shares";
import {
  type AppStorePort,
  type ArtifactStorageService,
  createArtifactStorageService,
} from "@repo/services/artifacts/storage";
import {
  type BrowserService,
  createBrowserService,
} from "@repo/services/browser";
import type { BrowserDriver } from "@repo/services/browser/types";
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
  type ConversationsService,
  createConversationsService,
} from "@repo/services/conversations";
import {
  type CredentialsService,
  createCredentialsService,
} from "@repo/services/credentials";
import { createDeskService, type DeskService } from "@repo/services/desk";
import {
  createDeskApiService,
  type DeskApiService,
  type MemberDirectory,
} from "@repo/services/desk-api";
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
  createInvestigatorReportBack,
  createReportedReader,
  createRunRequestReader,
} from "@repo/services/investigator-report";
import {
  createLibraryService,
  type LibraryBlobs,
  type LibraryService,
} from "@repo/services/library";
import {
  createLibraryAccessService,
  type LibraryAccessService,
} from "@repo/services/library/access";
import { createLibraryAudience } from "@repo/services/library/audience";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { createTaskFiles } from "@repo/services/library/task-files";
import {
  createLibraryLinksService,
  type LibraryLinksService,
} from "@repo/services/library-links";
import {
  createLiveArtifactsWithAsk,
  type LiveArtifactsWithAsk,
} from "@repo/services/live-artifacts/factory";
import {
  createLiveExportsService,
  type LiveExportsService,
  type PrintPDF,
} from "@repo/services/live-exports";
import type { GuestRunnerPort } from "@repo/services/live-guests/durable-runtime";
import { createGuestRunAccess } from "@repo/services/live-guests/run-access";
import {
  createMachinesService,
  type MachinesService,
} from "@repo/services/machines";
import { createTakeoverLease } from "@repo/services/machines/lease";
import { createMachineRuntime } from "@repo/services/machines/runtime";
import type { MachineRelayPort } from "@repo/services/machines/types";
import { createMailService, type MailService } from "@repo/services/mail";
import {
  createMailOutbound,
  type MailOutbound,
} from "@repo/services/mail/outbound";
import type { EmailRoutingPort, MailboxPort } from "@repo/services/mail/types";
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
import { createMapService, type MapService } from "@repo/services/map";
import {
  createMembersService,
  type MemberLister,
  type MembersService,
} from "@repo/services/members";
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
import { createQaService, type QaService } from "@repo/services/qa";
import { createRailService, type RailService } from "@repo/services/rail";
import {
  createRequestsService,
  type RequestsService,
} from "@repo/services/requests";
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
import type { GithubSkillFetcher as SkillsStoreGithubFetcher } from "@repo/services/skills-store/github";
import { memorySkillBlobs } from "@repo/services/skills-store/memory";
import {
  createSlackService,
  type SlackDirectory,
  type SlackService,
} from "@repo/services/slack";
import { createSlackGateway } from "@repo/services/slack/gateway";
import {
  createSlackRequests,
  type SlackRequests,
} from "@repo/services/slack/requests";
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
  createTakeoverService,
  type TakeoverService,
} from "@repo/services/takeover";
import {
  createTasksService,
  type TasksService,
} from "@repo/services/tasks/service";
import {
  createTriggersService,
  type TriggersService,
} from "@repo/services/triggers";
import {
  createWikiLinkIndex,
  createWikiService,
  type WikiService,
} from "@repo/services/wiki/service";
import {
  createWikiSuggestionsService,
  type WikiSuggestionsService,
} from "@repo/services/wiki/suggestions";
import {
  createWorkspacesService,
  type OrganizationsPort,
  SYSTEM_PRINCIPAL,
  type UserOrganization,
} from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/d1";
import {
  createCardFetcher,
  createPairingTransport,
  createPeerFetch,
} from "./a2a-transport.ts";
import { appStorePort } from "./app-store/port.ts";
import { browserRunDriver, exportPrintPDF } from "./browser-run.ts";
import { clerkMembers } from "./clerk-members.ts";
import { clerkOrgName } from "./clerk-org-name.ts";
import {
  clerkOrganizations,
  clerkUserOrganizations,
} from "./clerk-organizations.ts";
import { clerkPeople } from "./clerk-people.ts";
import { createGithubSkillFetcher } from "./github-skill-source.ts";
import { guestRuntimeOptions } from "./guest-runtime-options";
import { inProcessFetch } from "./in-process.ts";
import { libraryNotifier } from "./library-notifier.ts";
import { liveArtifactMutations } from "./live-artifacts/artifact-mutations";
import {
  type GuestComposition,
  guestService,
} from "./live-artifacts/guest-infra";
import { type LiveInfra, productionLiveInfra } from "./live-artifacts/infra";
import { type MailEnv, mailInfra } from "./mail-infra.ts";
import { durablePollerPort } from "./managed-poller-port.ts";
import { clerkEmailMemberLookup } from "./mcp/clerk-email-member.ts";
import { clerkOrgMemberCheckFresh } from "./mcp/clerk-membership.ts";
import { takeDesktopScreenshot } from "./mcp/computer-ports.ts";
import { durableRunnerPort } from "./pi-run-port.ts";
import { r2Blobs } from "./r2-blobs.ts";
import { r2FileBlobs } from "./r2-files.ts";
import { r2LibraryBlobs } from "./r2-library.ts";
import { r2SkillBlobs } from "./r2-skills.ts";
import { durableRelayPort } from "./relay-port.ts";
import { readManifest } from "./releases/store.ts";
import { TASK_EVENT_TYPES } from "./session-stream-frames.ts";
import {
  type SessionStreamPort,
  streamListener,
  streamPublisher,
} from "./session-stream-port.ts";
import { clerkSlackDirectory } from "./slack-directory.ts";

/** What the runs service needs besides a database. */
const unavailableAppStore: AppStorePort = {
  delete: () => Promise.reject(new Error("App storage is not set up.")),
  get: () => Promise.reject(new Error("App storage is not set up.")),
  list: () => Promise.reject(new Error("App storage is not set up.")),
  set: () => Promise.reject(new Error("App storage is not set up.")),
};

export interface Infra {
  appErrorSlot?: AppErrorSlot;
  appReply?: AppReply;
  /** The app storage Durable Object behind its port. B.8 wires it; without it, storage answers "unavailable". */
  appStore?: AppStorePort;
  /** `ARTIFACT_LINKS_OFF` is set: every share-link open is refused in this environment. */
  artifactLinksOff?: boolean;
  /** `ARTIFACT_VIEW_KEY`. Artifact view tokens are signed with it; without it, opening an artifact fails. */
  artifactViewKey?: string;
  atomic: Atomic;
  blobs: Blobs;
  /** Drives the agents' browser: Browser Run in the app. Without it, browser tools answer "unavailable". */
  browserDriver?: BrowserDriver;
  clock: Clock;
  /** Starts and stops the work of a cloud run. Without it, `cloud` agents cannot run. */
  cloudRunner?: CloudRunnerPort;
  /** Runs work after the response: `waitUntil` in a request. Without it, work is awaited. */
  defer?: (work: Promise<void>) => void;
  devFakeRuntime: boolean;
  dictationLimits?: DictationLimits;
  exportPDF?: PrintPDF;
  /** How connector probes reach the network. Defaults to the global `fetch`. */
  fetch?: Fetcher;
  /** Where uploaded files live: R2 in the app. */
  fileBlobs: FileBlobs;
  /** Reads skills from GitHub (V7.9). Without it, GitHub import and update checks answer "not set up". */
  github?: GithubSkillFetcher;
  /** `GITHUB_TOKEN`, optional. Raises GitHub's rate limit; without it the fetcher is unauthenticated. */
  githubToken?: string;
  guestRunner?: GuestRunnerPort;
  guests?: (input: GuestComposition) => ReturnType<typeof guestService>;
  guestsOff?: () => boolean;
  /** Whether a user is in a Clerk org right now, with no cache. Live link calls need it; without it they are refused. */
  isOrgMember?: (userId: string, clerkOrgId: string) => Promise<boolean>;
  /** The version of the newest published daemon. Without it the machines page shows no update note. */
  latestDaemonVersion?: (product?: Product) => Promise<string | null>;
  /** Where the workspace library keeps file bytes: R2 in the app. Tests omit it and get an in-memory store. */
  libraryBlobs?: LibraryBlobs;
  live?: LiveInfra;
  mailbox?: MailboxPort;
  mailDomain?: string;
  mailRouting?: EmailRoutingPort;
  /** The Managed Agents gateway on a workspace's key. Without it, managed runs fail their step. */
  managedGatewayFor?: ManagedServiceOptions["gatewayFor"];
  /** Wakes the poller of a managed run. Without it, `managed` agents cannot run. */
  managedPoller?: ManagedPollerPort;
  /** Finds the workspace member behind a verified email, for the desk API. Without one, no desk key resolves a member. */
  memberDirectory?: MemberDirectory;
  /** Lists a Clerk organisation's members, for the rail and the owner pickers. Without it, owners cannot be set and Mine shows everything. */
  members?: MemberLister;
  /** Makes and deletes Clerk organisations, for the New workspace menu entry. Without it, a workspace cannot be created in the app. */
  organizations?: OrganizationsPort;
  /** Reads a Clerk organisation's name, for naming a workspace. Without it, a workspace is named by its org id. */
  orgName?: (clerkOrgId: string) => Promise<string | null>;
  /**
   * How we reach an A2A peer: no private address, no redirect, HTTPS outside
   * dev, a timeout, and in-process dispatch for our own origin. Without it,
   * pairing and agent cards cannot be fetched and nothing is sent to a peer.
   */
  peerFetch?: A2aFetch;
  /** Names the people behind user ids in the Log. Without it, the Log shows ids. */
  people?: PeopleLookup;
  /** `PUBLIC_BASE_URL`. A Connect path posted to Slack becomes a link under it. */
  publicBaseUrl?: string;
  relay: MachineRelayPort;
  /** `RUN_TOKEN_KEY`. Machine claims mint run tokens with it. */
  runTokenKey?: string;
  /** `SECRETS_KEY`. Storing a connector credential or a workspace secret encrypts with it. */
  secretsKey?: string;
  /** `GOOGLE_OAUTH_CLIENT_ID` and `_SECRET`, both or neither. The OAuth client for connectors on a googleapis.com host with Google endpoints. */
  sharedGoogleClient?: { clientId: string; clientSecret: string };
  /** Where the skills store keeps file bytes: R2 in the app. Tests omit it and get an in-memory store. */
  skillBlobs?: SkillBlobs;
  /** Finds the Clerk user behind a Slack email. Without one, nobody is linked. */
  slackDirectory?: SlackDirectory;
  /** Where the live frames of a session go: the SessionStream Durable Object in the app. Without it nothing is streamed. */
  streams?: SessionStreamPort;
  /** Runs a granted tool for artifacts (B.5). Tests replace it; the app builds the real one over its credentials. */
  toolRunner?: ToolRunner;
  /** Lists the Clerk organisations a person belongs to, for the workspace menu. Without it, the menu lists none. */
  userOrganizations?: (userId: string) => Promise<UserOrganization[]>;
  /** Asks Anthropic whether a key works. Without it, `managedKeys` checks only the key's shape. */
  validateAnthropicKey?: (apiKey: string) => Promise<boolean>;
  /** Asks the provider whether a key works. Without it, `modelKeys` checks only the key's shape. */
  validateModelKey?: (
    provider: ModelProvider,
    apiKey: string
  ) => Promise<boolean>;
}

export interface Services {
  a2aOutbound: OutboundService;
  a2aOutbox: OutboxService;
  a2aPageReads: PageReads;
  a2aTasks: A2aTasksService;
  admin: AdminService;
  agentBuilder: AgentBuilderService;
  agentProfile: AgentProfileService;
  agents: AgentsService;
  apiKeys: ApiKeysService;
  artifactApp: AppGrantsService;
  artifactCalls: ArtifactToolPort;
  artifactEndpoints: ArtifactEndpointsService;
  artifactErrors: ReturnType<typeof createArtifactErrorsService>;
  artifactGrants: ArtifactGrantsService;
  artifactPins: ArtifactPinsService;
  artifactShares: ArtifactSharesService;
  artifactStorage: ArtifactStorageService;
  artifacts: ArtifactsService;
  assistant: AssistantService;
  browser: BrowserService;
  connections: ConnectionsService;
  connectorOAuth: ConnectorOAuthService;
  connectors: ConnectorsService;
  conversations: ConversationsService;
  credentials: CredentialsService;
  desk: DeskService;
  deskApi: DeskApiService;
  dictation: DictationService;
  dictationLimits?: DictationLimits;
  events: EventsService;
  files: FilesService;
  inbox: InboxService;
  library: LibraryService;
  libraryAccess: LibraryAccessService;
  libraryLinks: LibraryLinksService;
  liveArtifacts?: LiveArtifactsWithAsk;
  liveExports?: LiveExportsService;
  liveGuests?: () => Promise<
    import("@repo/services/live-guests/service").LiveGuestsService
  >;
  liveRoom?: LiveInfra["roomFor"];
  machines: MachinesService;
  mail: MailService & MailOutbound;
  managed: ManagedService;
  managedKeys: ManagedKeysService;
  map: MapService;
  members: MembersService;
  modelKeys: ModelKeysService;
  network: NetworkService;
  oauthClients: OAuthClientsService;
  qa: QaService;
  rail: RailService;
  requests: RequestsService;
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
  slackRequests: SlackRequests;
  slackSend: SlackSendService;
  takeover: TakeoverService;
  tasks: TasksService;
  triggers: TriggersService;
  wiki: WikiService;
  wikiSuggestions: WikiSuggestionsService;
  workspaces: ReturnType<typeof createWorkspacesService>;
}

export interface Composed {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  /** The machine relay, for the computer tools of a run: they act per machine, not through a service. */
  relay: MachineRelayPort;
  services: Services;
}

/** The bindings and secrets `compose` reads. */
export type ComposeEnv = Pick<
  Env,
  | "ARTIFACT_ROOM"
  | "LIVE_ARTIFACT_MAINTENANCE"
  | "LOADER"
  | "APP_STORE"
  | "APP_API_LIMIT"
  | "SHARE_OPEN_LIMIT"
  | "ARTIFACT_LINKS_OFF"
  | "ARTIFACT_VIEW_KEY"
  | "BROWSER"
  | "CLERK_SECRET_KEY"
  | "DB"
  | "FILES"
  | "GITHUB_TOKEN"
  | "MACHINE_RELAY"
  | "MANAGED_POLLER"
  | "GUEST_RUN"
  | "PI_RUN"
  | "PUBLIC_BASE_URL"
  | "RUN_TOKEN_KEY"
  | "SECRETS_KEY"
  | "SESSION_STREAM"
> &
  MailEnv & {
    /** Optional secrets, declared here so the type check does not depend on a developer's env file listing them. */
    GOOGLE_OAUTH_CLIENT_ID?: string;
    GOOGLE_OAUTH_CLIENT_SECRET?: string;
  };

/** A peer fetch that refuses everything, for a composition that has none. */
const peerFetchOf = (configured: A2aFetch | undefined): A2aFetch =>
  configured ??
  (() => Promise.reject(new Error("No A2A peer fetch is configured.")));

/** What the connections service needs to pair and read cards. Nothing until a peer fetch exists. */
const pairingPortsOf = (configured: A2aFetch | undefined) =>
  configured
    ? {
        fetchCard: createCardFetcher(configured),
        transport: createPairingTransport(configured),
      }
    : {};

const noGateway: ManagedServiceOptions["gatewayFor"] = () => {
  throw new Error("No Managed Agents gateway is configured.");
};

const noopPoller: ManagedPollerPort = {
  cancel: () => Promise.resolve(),
  kick: () => Promise.resolve(),
};

/** The browser of a deployment with no Browser Run: every action answers "unavailable". */
const noBrowserDriver: BrowserDriver = {
  connect: () => Promise.reject(new Error("No browser is configured.")),
  launch: () => Promise.reject(new Error("No browser is configured.")),
};

/** A directory that knows nobody: every unknown Slack sender stays unlinked. */
const unlinkedDirectory: SlackDirectory = {
  findUserIdByEmail: () => Promise.resolve(null),
  isOrgMember: () => Promise.resolve(false),
};

/**
 * The skills store asks a fetcher to `resolve` and `tree`; the GitHub adapter
 * (the protocol port) offers `resolveCommit` and `fetchTree`.
 */
const skillsStoreGithub = (
  fetcher: GithubSkillFetcher
): SkillsStoreGithubFetcher => ({
  resolve: ({ repoUrl, ref, githubToken }) =>
    fetcher.resolveCommit(repoUrl, ref, githubToken),
  tree: async ({ repoUrl, commitSha, path, githubToken }) =>
    (
      await fetcher.fetchTree(
        repoUrl,
        commitSha,
        path ?? undefined,
        githubToken
      )
    ).files,
});

/** The services over a database and infra. Tests call this with fakes. */
const lazyGuestService = (
  factory: Infra["guests"],
  input: GuestComposition
): Services["liveGuests"] => {
  if (!factory) {
    return;
  }
  let guests: ReturnType<typeof guestService> | undefined;
  return () => {
    guests ??= factory(input);
    return guests;
  };
};

export const composeWith = ({
  db,
  infra,
}: {
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

  const workspaces = createWorkspacesService({
    db,
    organizations: infra.organizations,
    orgName: infra.orgName,
    publicBaseUrl: infra.publicBaseUrl,
    userOrganizations: infra.userOrganizations,
  });
  const events = createEventsService({
    blobs: infra.blobs,
    db,
    people: infra.people,
  });
  const members = createMembersService({ db, lister: infra.members });
  const agents = createAgentsService({
    atomic: infra.atomic,
    db,
    // Built lazily: `managedKeys` is made further down.
    dropVaults: async (workspaceId, vaultIds) => {
      const key = await managedKeys.resolve(workspaceId);
      if (!key) {
        return;
      }
      const gateway = (infra.managedGatewayFor ?? noGateway)({
        apiKey: key.apiKey,
        environment: {
          read: () => Promise.resolve(key.environmentId),
          write: (id) => managedKeys.rememberEnvironment(workspaceId, id),
        },
      });
      await Promise.all(
        vaultIds.map((vaultId) =>
          gateway.deleteVault(vaultId).catch((error: unknown) => {
            console.error("Deleting a managed session vault failed:", error);
          })
        )
      );
    },
    events,
    members,
  });
  const apiKeys = createApiKeysService({ clock: infra.clock, db, events });
  const peerFetch = peerFetchOf(infra.peerFetch);
  const a2aPageReads = createPageReads({ db, people: infra.people });
  // Dev builds let a peer live on localhost over plain http, so two local
  // deployments can reach each other. A deployed Worker refuses both.
  const connections = createConnectionsService({
    allowLoopback: infra.devFakeRuntime,
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    publicBaseUrl: infra.publicBaseUrl,
    secretsKey: infra.secretsKey,
    ...pairingPortsOf(infra.peerFetch),
  });
  // Delivers the push rows a task change queued. The outbox is built further
  // down, so this reads it when it runs.
  const deliverQueuedPushes = () => a2aOutbox.deliverDue(SYSTEM_PRINCIPAL);
  // Inbound A2A tasks. The runs and requests services are built below, and
  // this service's gateway goes into the runs service, so it reaches both lazily.
  const a2aTasks = createA2aTasksService({
    allowLoopback: infra.devFakeRuntime,
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    // A push goes out as soon as its task changes. The minute tick is the backstop.
    onPushQueued: () =>
      infra.defer?.(
        deliverQueuedPushes().then(
          () => undefined,
          () => undefined
        )
      ),
    requests: {
      answerAsPeer: (principal, input) =>
        requests.answerAsPeer(principal, input),
    },
    runs: {
      cancelRun: (principal, runId) => runs.cancelRun(principal, runId),
      startRun: (principal, input, options) =>
        runs.startRun(principal, input, options),
    },
    secretsKey: infra.secretsKey,
  });
  // Ends the tasks and the runs of a connection that was revoked.
  connections.onRevoked(a2aTasks.onConnectionRevoked);
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
    sharedGoogleClient: infra.sharedGoogleClient,
  });
  const connectorOAuth = createConnectorOAuthService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
    sharedGoogleClient: infra.sharedGoogleClient,
  });
  const credentials = createCredentialsService({
    clock: infra.clock,
    db,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const toolRunner =
    infra.toolRunner ??
    createToolRunner({ credentials, db, fetch: connectorFetch });
  const artifactCalls = createArtifactCallsService({ db, runner: toolRunner });
  const artifactStorage = createArtifactStorageService({
    db,
    store: infra.appStore ?? unavailableAppStore,
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
  const libraryBlobs = infra.libraryBlobs ?? memoryLibraryBlobs();
  const library = createLibraryService({
    atomic: infra.atomic,
    blobs: libraryBlobs,
    clock: infra.clock,
    db,
    events,
    linkIndex: createWikiLinkIndex({ db }),
    notify: libraryNotifier({
      audience: createLibraryAudience({ db }),
      defer: infra.defer,
      relay: infra.relay,
      runner: infra.cloudRunner,
    }),
  });
  const artifactShares = createArtifactSharesService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    isOrgMember: infra.isOrgMember,
    linksOff: infra.artifactLinksOff,
    origin: infra.publicBaseUrl ?? "",
    people: infra.people,
    runner: toolRunner,
    secretsKey: infra.secretsKey,
    store: infra.appStore ?? unavailableAppStore,
    viewKey: infra.artifactViewKey ?? "",
  });
  const browser = createBrowserService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    driver: infra.browserDriver ?? noBrowserDriver,
    events,
    library,
  });
  const wiki = createWikiService({ db, library });
  const wikiSuggestions = createWikiSuggestionsService({
    atomic: infra.atomic,
    blobs: libraryBlobs,
    clock: infra.clock,
    db,
    events,
    library,
  });
  const libraryAccess = createLibraryAccessService({
    atomic: infra.atomic,
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
    github: skillsGithub(infra.github),
    githubToken: infra.githubToken,
    library,
    onDeleted: ({ skillId, workspaceId }) =>
      managed.retireSkill(workspaceId, skillId),
  });
  const runSkills = createRunSkillsService({ skillsStore });
  const machines = createMachinesService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    latestDaemonVersion: infra.latestDaemonVersion,
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
  const oauthClients = createOAuthClientsService({
    clock: infra.clock,
    db,
    publicBaseUrl: infra.publicBaseUrl,
  });
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
    library,
    publicBaseUrl: infra.publicBaseUrl,
    secretsKey: infra.secretsKey,
    taskFiles: createTaskFiles({ db }).taskFiles,
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
  // An approval or a question goes to Slack as a card, and the card settles when it closes.
  // `requests` is built below, so the card code reaches it lazily.
  const slackRequests = createSlackRequests({
    clock: infra.clock,
    db,
    defer: infra.defer,
    fetch: connectorFetch,
    publicBaseUrl: infra.publicBaseUrl,
    requests: {
      answer: (principal, input) => requests.answer(principal, input),
      cancel: (principal, requestId) => requests.cancel(principal, requestId),
      outcome: (principal, requestId) => requests.outcome(principal, requestId),
    },
    secretsKey: infra.secretsKey,
  });
  events.onAppend(slackRequests.onEvent);
  // Catches `slack.delivered`, which the gateway writes through this instance.
  events.onAppend(slackStatus.onEvent);
  const artifactErrors = createArtifactErrorsService({
    db,
    events,
    slot: infra.appErrorSlot,
  });
  const appReplies = createAppReplies({
    db,
    defer: infra.defer,
    errors: artifactErrors,
    events,
    invoke: infra.appReply,
  });
  const gateways: Gateway[] = [
    inbox.gateway,
    slackGateway,
    a2aTasks.gateway,
    appReplies.gateway,
  ];
  const runs = createRunsService({
    adapters,
    atomic: infra.atomic,
    blobs: infra.blobs,
    clock: infra.clock,
    db,
    devFakeRuntime: infra.devFakeRuntime,
    gateways,
    ...guestRuntimeOptions({
      db,
      managedKeys,
      modelKeys,
      runner: guestRunnerFor(infra),
    }),
    guestsOff: infra.guestsOff,
    library,
    people: infra.people,
    runTokenKey: infra.runTokenKey,
    secrets,
  });
  const mail = createMailService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    domain: infra.mailDomain,
    events,
    library,
    mailbox: infra.mailbox,
    routing: infra.mailRouting,
    runs,
  });
  const requests = createRequestsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    guestPresence: infra.live?.guestPresence,
    runs,
    runTokenKey: infra.runTokenKey,
    secrets,
  });
  const artifactEndpoints = createArtifactEndpointsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    errors: artifactErrors,
    publicBaseUrl: infra.publicBaseUrl,
  });
  const artifactApp = createAppGrantsService({
    db,
    fire: (...args) => triggers.fire(...args),
    isOrgMember: infra.isOrgMember,
    secrets,
  });
  const artifactGrants = createArtifactGrantsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    requests,
    tools: createConnectorToolCatalog(db),
  });
  const artifactPins = createArtifactPinsService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
  });
  const artifacts = createArtifactsService({
    atomic: infra.atomic,
    blobs: libraryBlobs,
    clock: infra.clock,
    db,
    events,
    grants: artifactGrants,
    library,
    people: infra.people,
  });
  const mailOutbound = createMailOutbound({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    events,
    forceApproval: requests.requiresGuestApproval,
    mailbox: infra.mailbox,
    memberDirectory: infra.memberDirectory,
    requests,
  });
  const takeover = createTakeoverService({
    db,
    events,
    lease: createTakeoverLease(infra.relay),
    requests,
  });
  // A takeover that expires, or whose run ends, lets go of the desktop too.
  events.onAppend(takeover.onEvent);
  // Catches the run and tool events the runs service writes through its own events instance.
  runs.onEvent(slackStatus.onEvent);
  // Moves an inbound A2A task as its run does: run events here, request events on `events`.
  runs.onEvent(appReplies.onEvent);
  runs.onEvent(a2aTasks.onEvent);
  events.onAppend(a2aTasks.onEvent);
  // Our agent calling a peer: a person's answer to the send card sends or drops the message, and a revoke ends open tasks.
  const a2aOutbound = createOutboundService({
    clock: infra.clock,
    db,
    events,
    fetch: peerFetch,
    publicBaseUrl: infra.publicBaseUrl,
    requests,
    runs,
    secretsKey: infra.secretsKey,
  });
  events.onAppend(a2aOutbound.onEvent);
  connections.onRevoked(a2aOutbound.onConnectionRevoked);
  const a2aOutbox = createOutboxService({
    activation: connections,
    clock: infra.clock,
    db,
    events,
    fetch: peerFetch,
    secretsKey: infra.secretsKey,
  });
  // An investigator run that ends, or finishes, without having reported tells control-plane to escalate.
  runs.onEvent(
    createInvestigatorReportBack({
      defer: infra.defer,
      fetch: connectorFetch,
      now: () => infra.clock.now(),
      reported: createReportedReader(db),
      requestOf: createRunRequestReader(db),
      secrets,
    }).onEvent
  );
  if (infra.streams) {
    const onStreamEvent = streamListener(infra.streams);
    events.onAppend(onStreamEvent);
    runs.onEvent(onStreamEvent);
  }
  const managed = createManagedService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    desktopScreenshot: async (machineId) => {
      const result = await takeDesktopScreenshot(infra.relay, machineId, {
        kind: "agent",
      });
      if (!result.ok) {
        return {
          message: result.reason ?? "The desktop screenshot failed.",
          ok: false,
        };
      }
      return {
        image: { data: result.image.data, mediaType: result.image.mimeType },
        ok: true,
      };
    },
    events,
    gatewayFor: infra.managedGatewayFor ?? noGateway,
    keys: managedKeys,
    library,
    libraryTransfer: { helper: TRANSFER_HELPER_SOURCE },
    poller: infra.managedPoller ?? noopPoller,
    publicBaseUrl: infra.publicBaseUrl,
    requests,
    runs,
    runTokenKey: infra.runTokenKey,
    secrets,
    skills: (run) => createManagedSkillsSource({ runSkills, skillsStore }, run),
  });
  const routines = createRoutinesService({
    clock: infra.clock,
    db,
    events,
    runs,
  });
  const sessions = createSessionsService({
    authorizeScopedRun: runs.authorizeScopedRun,
    db,
    events,
  });
  const slack = createSlackService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    directory: infra.slackDirectory ?? unlinkedDirectory,
    events,
    fetch: connectorFetch,
    people: infra.people,
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
    outbound: requests.requireOutbound,
    secretsKey: infra.secretsKey,
  });
  const slackHistory = createSlackHistoryService({
    db,
    fetch: connectorFetch,
    secretsKey: infra.secretsKey,
  });
  const triggers = createTriggersService({
    clock: infra.clock,
    db,
    defer: infra.defer,
    events,
    runs,
  });
  const tasks = createTasksService({
    clock: infra.clock,
    db,
    events,
    eventTypes: TASK_EVENT_TYPES,
    people: infra.people,
    requests,
  });
  const map = createMapService({
    agents,
    atomic: infra.atomic,
    clock: infra.clock,
    connectors,
    db,
    events,
    machines,
    requests,
    routines,
    skillsStore,
    triggers,
  });
  // The desk's Needs you logic is shared: the web desk and the desk API read the same items.
  const desk = createDeskService({
    a2a: { connections, tasks: a2aTasks },
    clock: infra.clock,
    db,
    inbox,
    people: infra.people,
    requests,
    routines,
    skillsStore,
    triggers,
  });
  const rail = createRailService({
    agents,
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    desk,
    managedKeys,
    members,
    modelKeys,
    people: infra.people,
  });
  const agentBuilder = createAgentBuilderService({
    agents,
    connectors,
    fetch: connectorFetch,
    libraryAccess,
    machines,
    managedKeys,
    modelKeys,
    routines,
    runs,
    skillsStore,
  });
  const agentProfile = createAgentProfileService({
    agents,
    connectors,
    db,
    machines,
    requests,
    routines,
    secrets,
    skillsStore,
    slackApps,
    tasks,
    triggers,
  });
  const admin = createAdminService({
    agentProfile,
    agents,
    apiKeys,
    connectors,
    events,
    inbox,
    machines,
    mailDomain: infra.mailDomain,
    secrets,
  });
  const deskApi = createDeskApiService({
    agents,
    db,
    desk,
    // Without a directory no email names a member, so a desk key resolves nobody.
    directory: infra.memberDirectory ?? (() => Promise.resolve(null)),
    requests,
    runs,
  });
  const liveArtifacts = infra.live
    ? withLiveMaintenance(
        createLiveArtifactsWithAsk({
          scopedRunAccess: createGuestRunAccess({
            clock: infra.clock,
            db,
            guestsOff: infra.guestsOff ?? (() => true),
            runs,
          }),
          ...infra.live,
          artifacts,
          atomic: infra.atomic,
          blobs: libraryBlobs,
          clock: infra.clock,
          db,
          events,
          files,
          imageBlobs: infra.fileBlobs,
          runs,
        }),
        infra.live.wake
      )
    : undefined;
  const assistant = createAssistantService({
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    fetch: connectorFetch,
    managedKeys,
    masker: secrets.workspaceMasker,
    modelKeyStatus: (principal, provider) =>
      provider === "anthropic"
        ? managedKeys.status(principal)
        : modelKeys.status(principal, provider),
    secrets,
    tools: (principal) =>
      assistantTools(
        createMcpPorts({
          principal,
          publicBaseUrl: infra.publicBaseUrl,
          services: composed.services,
        }),
        principal.kind === "user" && principal.isAdmin === true
      ),
  });
  const composed: Composed = {
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    relay: infra.relay,
    services: {
      a2aOutbound,
      a2aOutbox,
      a2aPageReads,
      a2aTasks,
      admin,
      agentBuilder,
      agentProfile,
      agents,
      apiKeys,
      artifactApp,
      artifactCalls,
      artifactEndpoints,
      artifactErrors,
      artifactGrants,
      artifactPins,
      artifactShares,
      artifactStorage,
      artifacts: liveArtifactMutations(artifacts, liveArtifacts),
      assistant,
      browser,
      connections,
      connectorOAuth,
      connectors,
      conversations: createConversationsService({ assistant, sessions }),
      credentials,
      desk,
      deskApi,
      dictation: createDictationService({ fetch: infra.fetch, modelKeys }),
      dictationLimits: infra.dictationLimits,
      events,
      files,
      inbox,
      library,
      libraryAccess,
      libraryLinks,
      liveArtifacts,
      liveExports: liveArtifacts
        ? createLiveExportsService({
            clock: infra.clock,
            db,
            files,
            live: liveArtifacts,
            printPDF: infra.exportPDF,
            rooms: infra.live?.rooms,
          })
        : undefined,
      liveGuests: lazyGuestService(infra.guests, {
        atomic: infra.atomic,
        clock: infra.clock,
        db,
        services: { events, liveArtifacts, runs },
      }),
      liveRoom: infra.live?.roomFor,
      machines,
      mail: { ...mail, ...mailOutbound },
      managed,
      managedKeys,
      map,
      members,
      modelKeys,
      network,
      oauthClients,
      qa: createQaService({
        atomic: infra.atomic,
        clock: infra.clock,
        db,
        events,
        runs,
      }),
      rail,
      requests,
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
      slackRequests,
      slackSend,
      takeover,
      tasks,
      triggers,
      wiki,
      wikiSuggestions,
      workspaces,
    },
  };
  return composed;
};

/**
 * The app's services on D1 and R2. The fake runtime is on in dev builds only,
 * so the caller passes `import.meta.env.DEV`.
 */
export const compose = (
  env: ComposeEnv,
  devFakeRuntime: boolean,
  defer?: (work: Promise<void>) => void,
  exports?: AppWorkerExports
): Composed => {
  const db = drizzle(env.DB);
  let composed: Composed;
  composed = composeWith({
    db,
    infra: {
      appErrorSlot: async (artifactId, restoreDropped) =>
        env.APP_STORE.get(env.APP_STORE.idFromName(artifactId)).errorSlot(
          restoreDropped
        ),
      // An empty `ARTIFACT_LINKS_OFF` leaves links on.
      appReply:
        exports && env.LOADER
          ? appReplyInvoker(env as Env, exports, () => composed.services)
          : undefined,
      appStore: appStorePort(env.APP_STORE),
      artifactLinksOff: Boolean(env.ARTIFACT_LINKS_OFF),
      artifactViewKey: env.ARTIFACT_VIEW_KEY || undefined,
      atomic: d1Atomic(db),
      blobs: r2Blobs(env.FILES),
      browserDriver: browserRunDriver(env.BROWSER),
      clock: systemClock,
      cloudRunner: durableRunnerPort(env.PI_RUN),
      defer,
      devFakeRuntime,
      dictationLimits: {
        polish: env.APP_API_LIMIT,
        transcribe: env.SHARE_OPEN_LIMIT,
      },
      exportPDF: exportPrintPDF(env.BROWSER),
      fileBlobs: r2FileBlobs(env.FILES),
      // A bare `fetch` loses its receiver in workerd ("Illegal invocation").
      github: createGithubSkillFetcher((url, init) => fetch(url, init)),
      // An unset secret reads as an empty string: GitHub then sees no credential.
      githubToken: env.GITHUB_TOKEN || undefined,
      guestRunner: env.GUEST_RUN
        ? {
            cancel: (runId) => env.GUEST_RUN.getByName(runId).cancel(runId),
            start: (runId) => env.GUEST_RUN.getByName(runId).start(runId),
          }
        : undefined,
      guests: (input) => guestService(env, input),
      guestsOff: () =>
        Boolean(
          (env as ComposeEnv & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF
        ),
      isOrgMember: clerkOrgMemberCheckFresh(env.CLERK_SECRET_KEY),
      libraryBlobs: r2LibraryBlobs(env.FILES),
      live: productionLiveInfra(env as Env, () => composed),
      peerFetch: createPeerFetch({
        allowHttp: devFakeRuntime,
        // A bare `fetch` loses its receiver in workerd ("Illegal invocation").
        fetch: (input, init) => fetch(input, init),
        localFetch: inProcessFetch(env as Env, defer),
        publicBaseUrl: env.PUBLIC_BASE_URL,
      }),
      ...mailInfra(env),
      // A bucket error must not take the machines page down with it.
      latestDaemonVersion: async (product = "agentum") => {
        try {
          return (await readManifest(env.FILES, product))?.version ?? null;
        } catch (error) {
          console.error("reading the latest daemon release failed", error);
          return null;
        }
      },
      managedGatewayFor: ({ apiKey, environment }) =>
        connectManagedGateway(apiKey, {
          cache: environment,
          environmentName: ENVIRONMENT_NAME,
        }),
      managedPoller: durablePollerPort(env.MANAGED_POLLER),
      memberDirectory: clerkEmailMemberLookup(env.CLERK_SECRET_KEY),
      members: clerkMembers(env.CLERK_SECRET_KEY),
      organizations: clerkOrganizations(env.CLERK_SECRET_KEY),
      orgName: clerkOrgName(env.CLERK_SECRET_KEY),
      people: clerkPeople(env.CLERK_SECRET_KEY),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      relay: durableRelayPort(env.MACHINE_RELAY),
      runTokenKey: env.RUN_TOKEN_KEY,
      secretsKey: env.SECRETS_KEY,
      // Unset secrets read as empty strings; Google's client needs both.
      sharedGoogleClient:
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
          ? {
              clientId: env.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            }
          : undefined,
      skillBlobs: r2SkillBlobs(env.FILES),
      slackDirectory: clerkSlackDirectory(env.CLERK_SECRET_KEY),
      streams: streamPublisher(env.SESSION_STREAM, defer),
      userOrganizations: clerkUserOrganizations(env.CLERK_SECRET_KEY),
      validateAnthropicKey,
      validateModelKey,
    },
  });
  return composed;
};

const LIVE_WAKE_METHODS = new Set<PropertyKey>([
  "createDocument",
  "convertDoc",
  "join",
  "restore",
  "invalidateAccess",
  "setAudience",
  "remove",
  "comment",
  "resolve",
  "answered",
  "ask",
  "askElement",
  "selectAgent",
  "retryCommentAsk",
  "revertChange",
  "recordChange",
  "uploadImage",
]);
const withLiveMaintenance = (
  service: LiveArtifactsWithAsk,
  wake: () => Promise<void>
): LiveArtifactsWithAsk =>
  new Proxy(service, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function" || !LIVE_WAKE_METHODS.has(key)) {
        return method;
      }
      return async (...args: unknown[]) => {
        await wake();
        return Reflect.apply(method, target, args);
      };
    },
  });

const skillsGithub = (github: Infra["github"]) =>
  github && skillsStoreGithub(github);

const guestRunnerFor = (infra: Infra) =>
  infra.runTokenKey && infra.publicBaseUrl && infra.live
    ? infra.guestRunner
    : undefined;
