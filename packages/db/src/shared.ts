// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const IDENTITY_PROVIDERS = ["slack"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const AGENT_RUNTIMES = ["machine", "managed", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

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

export const FILE_SOURCES = ["upload", "slack", "run"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

export const EVENT_TYPES = [
  "run.queued",
  "run.started",
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
