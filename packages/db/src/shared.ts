// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle. The
// schema takes its enum values from here too, so the UI and the tables agree.

export const IDENTITY_PROVIDERS = ["slack"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const SLACK_APP_STATUSES = ["created", "installed", "revoked"] as const;
export type SlackAppStatus = (typeof SLACK_APP_STATUSES)[number];

/** Which channel messages an app answers: only mentions, or every message in a channel it is in. */
export const SLACK_LISTEN_MODES = ["mentions", "all"] as const;
export type SlackListenMode = (typeof SLACK_LISTEN_MODES)[number];

export const AGENT_RUNTIMES = ["machine", "managed", "cloud", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const AGENT_STATUSES = ["active", "archived", "draft"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** How an agent speaks. The builder offers one of these. */
export const VOICE_PRESETS = [
  "brief",
  "careful",
  "friendly",
  "formal",
] as const;
export type VoicePreset = (typeof VOICE_PRESETS)[number];

/** The starting points the builder offers. */
export const AGENT_TEMPLATE_IDS = [
  "sort_inbox",
  "chase_invoices",
  "research_topic",
] as const;
export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];

/** The parts of an agent's profile the builder fills in and asks about. */
export const PROFILE_FIELDS = [
  "does",
  "voice",
  "rules",
  "tools",
  "skills",
  "starts_on",
  "hands_to",
  "runs_on",
  "library",
  "address",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** A profile field the builder cannot fill yet, and the question that would. */
export interface ProfileGap {
  field: ProfileField;
  question: string;
}

export const MACHINE_STATUSES = ["online", "offline", "revoked"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/**
 * The jobs one machine can hold. `agent_host` runs agents through the daemon.
 * `computer` is a client an agent drives (shell, files, desktop). One machine
 * can hold both roles, and a revoke ends both.
 */
export const MACHINE_ROLES = ["agent_host", "computer"] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

/** Presence of a machine's computer role. `machines.computer_status` is null when the machine has none. */
export const COMPUTER_STATUSES = ["online", "offline"] as const;
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "offered",
  "running",
  // At least one open request. The runtime keeps the lease going.
  "waiting",
  "done",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `desk` is the external desk API (`/api/desk/*`) and nothing else: `/mcp` refuses it.
 * `admin` is `write` plus the setup tools: secrets, machines, keys. Only a workspace admin mints one.
 */
export const API_KEY_ACCESS = ["read", "write", "desk", "admin"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

/** What a connected app may be given: a desk key is a key, never an OAuth client. */
export const OAUTH_CLIENT_ACCESS = ["read", "write"] as const;
export type OAuthClientAccess = (typeof OAUTH_CLIENT_ACCESS)[number];

/** Most files one run can take as input. The composer and `startRun` both enforce it. */
export const INPUT_FILES_MAX = 20;

/** Largest file the upload route and the files service accept: 50 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const TRIGGER_KINDS = ["http", "routine", "mail"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** A proposal from an agent's run that no person has approved yet. */
export const isPendingProposal = (row: {
  approvedAt: string | null;
  proposedByAgentId: string | null;
}): boolean => row.proposedByAgentId !== null && row.approvedAt === null;

/** Errors in a row that switch a routine off. */
export const ROUTINE_ERROR_LIMIT = 5;

/** Most bytes in one library file: 10 MB. */
export const LIBRARY_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Most bytes in one workspace's library: 1 GB. */
export const LIBRARY_MAX_BYTES = 1024 * 1024 * 1024;

export const LIBRARY_ENTRY_KINDS = ["file", "dir"] as const;
export type LibraryEntryKind = (typeof LIBRARY_ENTRY_KINDS)[number];

/** Where wiki pages live: the `wiki/` folder of the library. */
export const WIKI_ROOT = "wiki";

/** What a grant in `agent_library_access` allows on its path and below. */
export const LIBRARY_ACCESS_MODES = ["read", "write"] as const;
export type LibraryAccessMode = (typeof LIBRARY_ACCESS_MODES)[number];

/** One path an agent may read or write, as the claim and the settings page carry it. */
export interface LibraryAccessGrant {
  mode: LibraryAccessMode;
  path: string;
}

/** What a version row records: a write, a delete tombstone, a restore of an older version, or a move. */
export const LIBRARY_VERSION_OPS = [
  "write",
  "delete",
  "restore",
  "move",
] as const;
export type LibraryVersionOp = (typeof LIBRARY_VERSION_OPS)[number];

export const LIBRARY_CONFLICT_STATUSES = ["open", "resolved"] as const;
export type LibraryConflictStatus = (typeof LIBRARY_CONFLICT_STATUSES)[number];

/** `stale` means the page changed after the suggestion's base version, so it can no longer apply as written. */
export const WIKI_SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "stale",
] as const;
export type WikiSuggestionStatus = (typeof WIKI_SUGGESTION_STATUSES)[number];

/** Days a version is kept regardless of count. Older versions beyond the newest `LIBRARY_VERSION_KEEP_MIN` per file are pruned. */
export const LIBRARY_VERSION_KEEP_DAYS = 30;

/** Newest versions per file that survive pruning however old they are. */
export const LIBRARY_VERSION_KEEP_MIN = 20;

/** The folder a run writes its own task output to. A task is one run, so a follow-up run gets its own folder. */
export const taskFolderPath = (slug: string, runId: string): string =>
  `agents/${slug}/tasks/${runId}`;

/** A change to library paths, for the notifier that tells open surfaces and daemons to refetch. */
export interface LibraryChange {
  /** The run that made the change, or null for a person's. */
  byRunId: string | null;
  paths: string[];
  workspaceId: string;
}

export const FILE_SOURCES = ["upload", "slack", "run", "library"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

export const EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.cancelled",
  "run.finished",
  "run.failed",
  "run.interrupted",
  "run.limit_reached",
  "run.repeat_stopped",
  "run.waiting",
  "run.resumed",
  "run.dry_run_skipped",
  "request.opened",
  "request.answered",
  "request.expired",
  "request.cancelled",
  "tool_rule.changed",
  "message.user",
  "message.assistant",
  "message.reasoning",
  "tool.call",
  "tool.result",
  "connector.call",
  "connector.needs_auth",
  "connector.timeout",
  "connector.deleted",
  "trigger.fired",
  "trigger.created",
  "trigger.approved",
  "trigger.rejected",
  "trigger.deleted",
  "slack.received",
  "slack.named",
  "slack.unlinked_sender",
  "slack.event_refused",
  "slack.delivered",
  "slack.message_sent",
  "slack.app_installed",
  "slack.app_revoked",
  "slack.batch_started",
  "slack.listen_mode_changed",
  "inbox.posted",
  "inbox.loop_stopped",
  "mail.received",
  "mail.held",
  "mail.sent",
  "mail.rejected",
  "mail.bounced",
  "mail.failed",
  "mail.expired",
  "mailbox.provisioned",
  "mailbox.failed",
  "machine.online",
  "machine.offline",
  "computer.online",
  "computer.offline",
  "computer.exec",
  "computer.file",
  "computer.takeover_requested",
  "computer.taken",
  "computer.handed_back",
  "browser.action",
  "agent.created",
  "agent.updated",
  "agent.address_reserved",
  "credential.created",
  "credential.revoked",
  "api_key.created",
  "admin.action",
  "library.write",
  "library.delete",
  "library.command",
  "library.conflict",
  "library.restore",
  "library.access",
  "library.conflict.resolved",
  "wiki.suggestion",
  "wiki.suggestion.decided",
  "secret.delivered",
  "secret.injected",
  "network.request",
  "script.run",
  "skill.created",
  "skill.committed",
  "skill.approved",
  "skill.rejected",
  "skill.reverted",
  "skill.assigned",
  "skill.unassigned",
  "skill.pinned",
  "skill.imported",
  "skill.update_available",
  "skill.deleted",
  "qa.asked",
  "qa.answered",
  "qa.accepted",
  "qa.closed",
  "map.edited",
  "workspace.snapshot",
  "artifact.created",
  "artifact.published",
  "artifact.restored",
  "artifact.renamed",
  "artifact.audience_changed",
  "artifact.deleted",
  "artifact.share_created",
  "artifact.share_revoked",
  "artifact.links_switched",
  "artifact.promoted",
  "artifact.grant_decided",
  "artifact.handed_to",
  "artifact.member_added",
  "artifact.member_role_changed",
  "artifact.member_revoked",
  "artifact.guest_invited",
  "artifact.guest_code_sent",
  "artifact.guest_signed_in",
  "artifact.comment_created",
  "artifact.comment_resolved",
  "artifact.live_checkpoint",
  "artifact.agent_change_reverted",
  "artifact.guests_switched",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** A mailbox starts `provisioning`, turns `active` once its routing rule exists, and `failed` keeps the reason in `last_error`. */
export const MAILBOX_STATUSES = [
  "provisioning",
  "active",
  "failed",
  "disabled",
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const MAIL_DIRECTIONS = ["in", "out"] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

/**
 * Where a message stands. `held` waits for a person's approval, `rejected` was
 * denied, `expired` timed out unanswered, `bounced` came back undelivered and
 * `failed` never left.
 */
export const MAIL_MESSAGE_STATUSES = [
  "received",
  "held",
  "sent",
  "rejected",
  "expired",
  "bounced",
  "failed",
] as const;
export type MailMessageStatus = (typeof MAIL_MESSAGE_STATUSES)[number];

/** The tool name of an approval that holds an outgoing mail. */
export const MAIL_SEND_TOOL = "mail_send";

/** The tool key an "Always allow" on a mail recipient writes, one per address. */
export const mailToolKey = (address: string): string =>
  `mail:${address.trim().toLowerCase()}`;

/**
 * Payloads of the computer and browser events. None carries command output or
 * file bytes: those stay in the run's tool result and the files service.
 */
export interface ComputerPresencePayload {
  machineId: string;
}

export interface ComputerExecPayload {
  command: string;
  durationMs: number;
  /** Null when the process was killed or timed out. */
  exitCode: number | null;
  machineId: string;
}

export interface ComputerFilePayload {
  bytes: number;
  machineId: string;
  op: "get" | "put";
  path: string;
}

export interface ComputerTakeoverRequestedPayload {
  machineId: string;
  reason: string;
  requestId: string;
}

export interface ComputerTakenPayload {
  machineId: string;
  /** Clerk user id of the person who took over. */
  userId: string;
}

export interface ComputerHandedBackPayload {
  machineId: string;
  note?: string;
  userId: string;
}

export interface BrowserActionPayload {
  action: string;
  url?: string;
}

/**
 * Payloads of the Q&A, skill update and map events. Ids only, as `inbox.posted`
 * does, so no question text lands in the event log.
 */
export interface QaAskedPayload {
  questionId: string;
}

export interface QaAnsweredPayload {
  answerId: string;
  questionId: string;
}

export interface QaAcceptedPayload {
  answerId: string;
  questionId: string;
}

export interface QaClosedPayload {
  questionId: string;
}

export interface SkillUpdateAvailablePayload {
  commitSha: string;
  skillId: string;
}

export const MAP_EDIT_ACTIONS = ["moved", "reset"] as const;
export type MapEditAction = (typeof MAP_EDIT_ACTIONS)[number];

export interface MapEditedPayload {
  action: MapEditAction;
  nodeKey: string;
}

export const EVENT_ACTOR_KINDS = [
  "guest",
  "user",
  "agent",
  "trigger",
  "system",
  "api_key",
] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

/** How a workspace secret reaches an agent: added to its outgoing requests, or set as an environment variable. */
export const SECRET_MODES = ["env", "proxy"] as const;
export type SecretMode = (typeof SECRET_MODES)[number];

/** Model providers a workspace can bring its own key for. */
export const MODEL_PROVIDERS = ["openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const CONNECTOR_AUTH_KINDS = ["none", "header", "oauth"] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

/** Seconds a connector tool call may take before it is stopped. */
export const CONNECTOR_CALL_TIMEOUT_SECONDS = {
  default: 60,
  max: 300,
  min: 10,
} as const;

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

export const INBOX_AUTHOR_KINDS = ["user", "agent"] as const;
export type InboxAuthorKind = (typeof INBOX_AUTHOR_KINDS)[number];

/** Who wrote a skill version: a person, an agent's run, or the one-off library migration. */
export const SKILL_AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type SkillAuthorKind = (typeof SKILL_AUTHOR_KINDS)[number];

/** A person's version is `approved` at once, an agent's starts `proposed` and a person decides. */
export const SKILL_VERSION_STATUSES = [
  "approved",
  "proposed",
  "rejected",
] as const;
export type SkillVersionStatus = (typeof SKILL_VERSION_STATUSES)[number];

export const QA_STATUSES = ["open", "answered", "closed"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

/** Who wrote a question or answer: a person, or an agent's run. */
export const QA_AUTHOR_KINDS = ["user", "agent"] as const;
export type QaAuthorKind = (typeof QA_AUTHOR_KINDS)[number];

/** Limits the ask and answer paths both enforce. */
export const QA_TITLE_MAX = 200;
export const QA_BODY_MAX = 20_000;

/** Questions one agent may have open at once. */
export const QA_OPEN_PER_AGENT_MAX = 5;

/** Where a skill's files were imported from. GitHub only. */
export const SKILL_SOURCE_PROVIDERS = ["github"] as const;
export type SkillSourceProvider = (typeof SKILL_SOURCE_PROVIDERS)[number];

export const REQUEST_KINDS = ["approval", "question", "takeover"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const APPROVAL_DECISIONS = [
  "allow_once",
  "always_allow",
  "deny",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `ask` stops a tool call for a person's decision. No rule means `allow`. */
export const TOOL_RULE_MODES = ["ask", "allow"] as const;
export type ToolRuleMode = (typeof TOOL_RULE_MODES)[number];

export const ANSWER_SURFACES = ["web", "slack"] as const;
export type AnswerSurface = (typeof ANSWER_SURFACES)[number];

/** How long an approval stays open: one hour. */
export const APPROVAL_TTL_MS = 60 * 60_000;

/** How long a question stays open: one day. */
export const QUESTION_TTL_MS = 24 * 60 * 60_000;

/** How long a takeover request stays open: as long as a question. */
export const TAKEOVER_TTL_MS = QUESTION_TTL_MS;

/** Most questions in one ask-user request. */
export const QUESTIONS_MAX = 4;

/** Most choices on one question. */
export const CHOICES_MAX = 6;

/** The kinds of line in a task's action log. */
export const ACTION_LOG_KINDS = [
  "thought",
  "tool_call",
  "tool_result",
  "note",
  "error",
] as const;
export type ActionLogKind = (typeof ACTION_LOG_KINDS)[number];

/** The three lanes of the desk, left to right. */
export const DESK_LANES = ["needs_you", "running", "done"] as const;
export type DeskLane = (typeof DESK_LANES)[number];

/** What a Needs you card asks of a person. Later milestones append theirs. */
export const NEEDS_YOU_KINDS = [
  "approval",
  "question",
  "skill_proposal",
  "trigger_proposal",
  "routine_proposal",
  "inbox_reply",
  "library_conflict",
  "wiki_suggestion",
  "takeover",
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The colour of a status band. */
export const BAND_TONES = ["ok", "waiting", "running", "error"] as const;
export type BandTone = (typeof BAND_TONES)[number];

/** One key and value shown as a chip on a receipt step. */
export interface KeyChip {
  key: string;
  value: string;
}

export const RECEIPT_STEP_KINDS = [
  "trigger",
  "message",
  "tool",
  "skill",
  "approval",
  "question",
  "result",
  "error",
] as const;
export type ReceiptStepKind = (typeof RECEIPT_STEP_KINDS)[number];

export const RECEIPT_STEP_STATES = [
  "done",
  "running",
  "paused",
  "failed",
] as const;
export type ReceiptStepState = (typeof RECEIPT_STEP_STATES)[number];

/** One step of a task's receipt: what went in, what came out, and what it links to. */
export interface ReceiptStep {
  /** How many of the next kind of thing this step handed on, or null for the last step. */
  countToNext: { n: number; noun: string } | null;
  detail: string;
  /** The events the step was built from. */
  eventIds: string[];
  in: KeyChip[];
  index: number;
  kind: ReceiptStepKind;
  out: KeyChip[];
  /** The V1 request this approval or question links to, when available. */
  requestId?: string;
  state: ReceiptStepState;
  title: string;
}

/** One line of a task's action log. */
export interface ActionLogEntry {
  at: string;
  eventId: string;
  kind: ActionLogKind;
  text: string;
}

/** The one sentence under a desk card or a task title, with the colour it takes. */
export interface StatusBand {
  text: string;
  tone: BandTone;
}

export const DESK_CARD_KINDS = [
  "run",
  "thread",
  "request",
  "proposal",
  "conflict",
] as const;
export type DeskCardKind = (typeof DESK_CARD_KINDS)[number];

/** One card on the desk. */
export interface DeskCard {
  /** "user" when a person started the card. Name them from `startedBy`, not `agentId`. */
  actorKind?: "user";
  agentId: string;
  at: string;
  band: StatusBand;
  id: string;
  kind: DeskCardKind;
  lane: DeskLane;
  needsYouKind?: NeedsYouKind;
  runId?: string;
  startedBy: string;
  threadId?: string;
  title: string;
}

export const MAP_NODE_KINDS = ["trigger", "agent", "output"] as const;
export type MapNodeKind = (typeof MAP_NODE_KINDS)[number];

/** What starts an agent. `slack` is an agent's Slack app, which is not a `triggers` row. */
export const MAP_TRIGGER_KINDS = ["http", "routine", "mail", "slack"] as const;
export type MapTriggerKind = (typeof MAP_TRIGGER_KINDS)[number];

/** Where an agent's work lands. */
export const MAP_OUTPUT_KINDS = ["slack", "library", "qa", "email"] as const;
export type MapOutputKind = (typeof MAP_OUTPUT_KINDS)[number];

/** What an agent carries: a connector, its computer, its browser, or a skill. */
export const MAP_PORT_KINDS = [
  "connector",
  "computer",
  "browser",
  "skill",
] as const;
export type MapPortKind = (typeof MAP_PORT_KINDS)[number];

export const MAP_WIRE_KINDS = [
  "trigger",
  "handoff",
  "slack",
  "library",
  "qa",
  "email",
] as const;
export type MapWireKind = (typeof MAP_WIRE_KINDS)[number];

/** A thing an agent node carries, drawn as a port on the node. */
export interface MapPort {
  /** The connector, machine or skill id, or the agent id for a browser. */
  id: string;
  kind: MapPortKind;
  label: string;
  /** Computer presence, when this is a computer port. */
  status?: string | null;
}

/**
 * One box on the map. `key` is what `map_positions.node_key` stores:
 * `trigger:<id>`, `trigger:slack:<slackAppId>`, `agent:<id>`,
 * `out:slack:<channel>`, `out:library:<folder>`, `out:qa` or `out:email:<agent>`.
 * `subkind` names the trigger or output type and is null for an agent.
 */
export interface MapNode<TRequest = unknown> {
  key: string;
  kind: MapNodeKind;
  label: string;
  /** Oldest visible pending request for the inspector. */
  pendingRequest?: TRequest;
  ports: MapPort[];
  subkind: MapTriggerKind | MapOutputKind | null;
  waiting?: boolean;
  x: number;
  y: number;
}

/** A line between two nodes, by key. `count7d` is the events over the last seven days. */
export interface MapWire {
  /** True when a run is going over this wire now. */
  active: boolean;
  /**
   * True when today's configuration draws this wire: a `triggers` row or slack
   * app, or a handoff in `hands_to`. A wire that only old events drew is
   * historical and not configured.
   */
  configured: boolean;
  count7d: number;
  from: string;
  kind: MapWireKind;
  to: string;
}

export interface MapGraph<TRequest = unknown> {
  nodes: MapNode<TRequest>[];
  wires: MapWire[];
}

/** `app` is phase 2: a micro app with a server part. Pages and dashboards are served the same way. */
export const ARTIFACT_KINDS = [
  "page",
  "doc",
  "dashboard",
  "app",
  "document",
  "deck",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** `private`: the owner and admins. `workspace`: every member. Phase 4 adds `people` and `public`. */
export const ARTIFACT_AUDIENCES = ["private", "workspace"] as const;
export type ArtifactAudience = (typeof ARTIFACT_AUDIENCES)[number];

export const ARTIFACT_AUTHOR_KINDS = ["user", "agent"] as const;
export type ArtifactAuthorKind = (typeof ARTIFACT_AUTHOR_KINDS)[number];

/** Phase 2: an agent's app version starts `proposed` until promoted, `rejected` when a person says no. */
export const ARTIFACT_VERSION_STATUSES = [
  "published",
  "proposed",
  "rejected",
] as const;
export type ArtifactVersionStatus = (typeof ARTIFACT_VERSION_STATUSES)[number];

/** Who a view token was minted for. `test` is the Browser Run token of `artifact_test`. */
export const ARTIFACT_VIEWER_KINDS = ["member", "link", "test"] as const;
export type ArtifactViewerKind = (typeof ARTIFACT_VIEWER_KINDS)[number];

/** Where an open happened. `live_call` is a tool call on a live link (phase 2). */
export const ARTIFACT_VIEW_SURFACES = [
  "viewer",
  "thread",
  "share",
  "test",
  "live_call",
  "guest",
  "room",
] as const;
export type ArtifactViewSurface = (typeof ARTIFACT_VIEW_SURFACES)[number];

/** `refused`, `rate_limited` and `error` are phase 2 outcomes of a live call. */
export const ARTIFACT_VIEW_OUTCOMES = [
  "ok",
  "revoked",
  "expired",
  "disabled",
  "refused",
  "rate_limited",
  "error",
] as const;
export type ArtifactViewOutcome = (typeof ARTIFACT_VIEW_OUTCOMES)[number];

export const ARTIFACT_SHARE_KINDS = ["link"] as const;
export type ArtifactShareKind = (typeof ARTIFACT_SHARE_KINDS)[number];

/** A `snapshot` link shows the data shipped in the version. A `live` link may call tools as its granter. */
export const ARTIFACT_SHARE_DATA_MODES = ["snapshot", "live"] as const;
export type ArtifactShareDataMode = (typeof ARTIFACT_SHARE_DATA_MODES)[number];

export const ARTIFACT_GRANT_KINDS = ["tool", "secret", "host"] as const;
export type ArtifactGrantKind = (typeof ARTIFACT_GRANT_KINDS)[number];

export const ARTIFACT_GRANT_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type ArtifactGrantStatus = (typeof ARTIFACT_GRANT_STATUSES)[number];

export const ARTIFACT_PIN_SURFACES = ["sidebar", "desk"] as const;
export type ArtifactPinSurface = (typeof ARTIFACT_PIN_SURFACES)[number];

/** Most files in one artifact version. */
export const ARTIFACT_MAX_FILES = 200;

/** Most bytes in one artifact version, over all files: 16 MB. */
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

/** Most bytes in one artifact file: 10 MB. */
export const ARTIFACT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Most bytes in one workspace's artifact blobs: 1 GB. */
export const ARTIFACT_WORKSPACE_MAX_BYTES = 1024 * 1024 * 1024;

/** Access-log rows older than this are deleted. */
export const ARTIFACT_VIEW_KEEP_DAYS = 365;

/** Most bytes of storage one micro app may hold (phase 2): 20 MB. */
export const ARTIFACT_APP_STORAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Limits on a live link's tool calls (phase 2). */
export const ARTIFACT_LIVE_LINK_LIMITS = {
  perDay: 1000,
  perMinute: 60,
  perVisitorPerMinute: 10,
} as const;

/**
 * Payload of `artifact.published`, appended once per new version (create,
 * update or restore). It reaches the session stream and the thread fold, which
 * key the card on this event, not on the tool name. Never holds a token.
 */
export interface ArtifactPublishedPayload {
  artifactId: string;
  kind: ArtifactKind;
  runId: string | null;
  sessionId: string | null;
  title: string;
  /** The tool call that made the version, when an agent did. */
  toolCallId?: string;
  version: number;
  versionId: string;
}

export const LIVE_KINDS = ["document", "deck"] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];
export const ARTIFACT_MEMBER_ROLES = ["viewer", "commenter", "editor"] as const;
export type ArtifactMemberRole = (typeof ARTIFACT_MEMBER_ROLES)[number];
export const GUEST_SESSION_HOURS = 12;
export const GUEST_CODE_MINUTES = 10;
export const GUEST_CODE_MAX_ATTEMPTS = 5;
export const GUEST_AGENT_RUNS_PER_DAY = 20;
export const ROOM_TICKET_SECONDS = 120;
export const ROOM_CONNECTION_MINUTES = 15;
export const LIVE_DOC_MAX_BYTES = 8 * 1024 * 1024;
export const LIVE_COMMENT_MAX_BYTES = 4096;
export const LIVE_THREADS_MAX = 1000;
export const LIVE_COMMENTS_PER_THREAD_MAX = 100;

export const SESSION_ORIGINS = [
  "ui",
  "slack",
  "mail",
  "inbox",
  "qa",
  "routine",
  "trigger",
  "mcp",
  "artifact",
] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number] | "dry_run";

/** Live checkpoint notification; no document bytes or room credentials in events. */
export interface ArtifactLiveCheckpointPayload {
  artifactId: string;
  revision: number;
  sessionId: string;
  versionId: string;
}
export const LIVE_POSITION_ENCODING_VERSION = 1;
export const LIVE_AGENT_PRESENCE_CLEAR_MS = 5000;
export const LIVE_POINTER_UPDATES_PER_SECOND = 20;
