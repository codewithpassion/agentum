// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const IDENTITY_PROVIDERS = ["slack"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const AGENT_RUNTIMES = ["machine", "managed", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_STATUSES = ["active", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MACHINE_STATUSES = ["online", "offline", "revoked"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "offered",
  "running",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const API_KEY_ACCESS = ["read", "write"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

/** Most files one run can take as input. The composer and `startRun` both enforce it. */
export const INPUT_FILES_MAX = 20;

/** Largest file the upload route and the files service accept: 50 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const TRIGGER_KINDS = ["http"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const FILE_SOURCES = ["upload", "slack", "run"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

export const EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.cancelled",
  "run.finished",
  "run.failed",
  "run.interrupted",
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "connector.call",
  "connector.needs_auth",
  "connector.timeout",
  "trigger.fired",
  "slack.received",
  "slack.unlinked_sender",
  "slack.delivered",
  "inbox.posted",
  "inbox.loop_stopped",
  "machine.online",
  "machine.offline",
  "agent.created",
  "agent.updated",
  "credential.created",
  "credential.revoked",
  "api_key.created",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_ACTOR_KINDS = [
  "user",
  "agent",
  "trigger",
  "system",
] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

export const CONNECTOR_AUTH_KINDS = ["none", "header", "oauth"] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const CONNECTOR_STATUSES = ["ok", "needs_auth"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const CREDENTIAL_OWNER_KINDS = ["user", "agent"] as const;
export type CredentialOwnerKind = (typeof CREDENTIAL_OWNER_KINDS)[number];

export const CREDENTIAL_STATUSES = ["ok", "needs_auth", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_MODES = ["user_or_agent", "agent", "user"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

/** How the token endpoint wants the client to identify itself (RFC 6749 section 2.3). */
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type TokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];
