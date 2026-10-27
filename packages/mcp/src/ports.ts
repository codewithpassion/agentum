import type { QaAuthorKind, QaStatus } from "@repo/db/shared";
import type { DesktopAction } from "@repo/protocol/computer";

/**
 * What the platform tools need from the app. The app builds one `McpPorts` per
 * request, already bound to the caller's principal and workspace, so a tool
 * never sees who is asking. A port throws `ToolError` for a failure the agent
 * should read (see result.ts); computer and browser ports instead return typed
 * failure values. This package imports no service.
 */

/** An agent the caller may message. `slug` is what tools take as `agent`. */
export interface AgentInfo {
  id: string;
  name: string;
  slug: string;
}

/** A run as the tools show it. `answer` is set once the run is `done`. */
export interface RunInfo {
  agentId: string;
  answer: string | null;
  error: string | null;
  runId: string;
  sessionId: string;
  /** One of queued, offered, running, done, failed, cancelled, interrupted. */
  status: string;
}

export interface SessionInfo {
  createdAt: string;
  id: string;
  lastRunAt: string | null;
  origin: string;
  /** Status of the latest run, or null when the session has none. */
  status: string | null;
  /** The first message, shortened. */
  title: string;
}

export interface TranscriptEntry {
  createdAt: string;
  /** `message.user`, `message.assistant`, `tool.call` or `tool.result`. */
  payload: Record<string, unknown>;
  type: string;
}

export interface SessionTranscript {
  entries: TranscriptEntry[];
  session: SessionInfo;
}

export interface SearchHit {
  /** Short excerpts around the matches, newest first. */
  passages: string[];
  session: SessionInfo;
}

/** An inbox thread as the tools show it. */
export interface ThreadInfo {
  createdAt: string;
  id: string;
  lastPostAt: string;
  title: string;
}

export interface PostInfo {
  /** The user id, or the agent id. */
  authorId: string;
  /** `user` or `agent`. */
  authorKind: string;
  createdAt: string;
  id: string;
  /** Set on an agent's post: the run that wrote it. */
  runId: string | null;
  text: string;
}

/** A thread with its newest posts, oldest first. */
export interface ThreadTranscript {
  posts: PostInfo[];
  thread: ThreadInfo;
}

/** A run that a post's mention started. */
export interface WokenRunInfo {
  agentId: string;
  runId: string;
}

export interface PostedInfo {
  post: PostInfo;
  /** The runs the post's `@slug` mentions started. Empty when none did. */
  runs: WokenRunInfo[];
}

/**
 * Where a routine or trigger stands. `awaiting_approval` is a proposal from an
 * agent's run: it is off until a person approves it in the Harbourmaster UI.
 */
export type AutomationStatus = "active" | "awaiting_approval" | "paused";

/** A routine: an agent started on a cron schedule. */
export interface RoutineInfo {
  agentId: string;
  agentName: string;
  cron: string;
  id: string;
  lastFiredAt: string | null;
  name: string;
  /** The next time it fires. Null while it is paused or awaiting approval. */
  nextRunAt: string | null;
  prompt: string;
  status: AutomationStatus;
  /** An IANA zone, in which the cron is read. */
  timezone: string;
}

/** An HTTP trigger: an outside system starts an agent with a secret. */
export interface TriggerInfo {
  agentId: string;
  agentName: string;
  id: string;
  lastFiredAt: string | null;
  name: string;
  status: AutomationStatus;
  /** The start of the secret, to tell triggers apart. Empty while awaiting approval. */
  tokenPrefix: string;
}

/** A trigger after it was created or switched on. `secret` is the only copy, and null when there is none to show. */
export interface TriggerChange {
  secret: string | null;
  trigger: TriggerInfo;
}

/** Public library metadata, matching the library service without exposing storage keys. */
export interface LibraryEntryInfo {
  etag: string | null;
  kind: "file" | "dir";
  mtime: string;
  path: string;
  size: number;
  updatedBy: { id: string; kind: "agent" | "user" };
}

export interface LibraryVersionInfo {
  authorId: string;
  authorKind: string;
  createdAt: string;
  etag: string;
  id: string;
  op: "write" | "delete" | "restore" | "move";
  path: string;
  runId: string | null;
  sha256: string;
  size: number;
  version: number;
}

/** Kinds an agent can publish. */
export type ArtifactKindInput = "page" | "doc" | "dashboard" | "app";

/** One file of a version, given as text or base64 bytes. */
export interface ArtifactFileInput {
  base64?: string;
  path: string;
  text?: string;
}

/** What `artifact_create` sends to the port. `entry` is always set. */
export interface ArtifactCreateInput {
  description?: string;
  entry: string;
  files?: ArtifactFileInput[];
  fromLibraryPath?: string;
  kind: ArtifactKindInput;
  message?: string;
  title: string;
}

/** What `artifact_update` sends to the port. Without `entry` the version keeps the current one. */
export interface ArtifactUpdateInput {
  artifactId: string;
  baseVersion: number;
  entry?: string;
  files?: ArtifactFileInput[];
  fromLibraryPath?: string;
  message?: string;
  title?: string;
}

/** A published version. Never carries a view or share token. */
export interface ArtifactPublished {
  artifactId: string;
  bytes: number;
  files: number;
  /** The sign-in URL, `https://<app>/a/<artifactId>`. */
  url: string;
  version: number;
  versionId: string;
}

export interface ArtifactVersionInfo {
  authorKind: "user" | "agent";
  createdAt: string;
  message: string | null;
  number: number;
  versionId: string;
}

export interface ArtifactFileText {
  contentType: string;
  path: string;
  size: number;
  text: string;
  version: number;
}

export interface ArtifactReadInfo {
  artifactId: string;
  audience: string;
  currentVersion: number;
  description: string | null;
  /** The text of the requested file, or of the entry file of the requested version. */
  file: ArtifactFileText;
  kind: string;
  title: string;
  url: string;
  versions: ArtifactVersionInfo[];
}

export interface ArtifactSummary {
  artifactId: string;
  audience: string;
  currentVersion: number;
  description: string | null;
  kind: string;
  title: string;
  updatedAt: string;
  url: string;
}

export interface ArtifactTestInfo {
  /** Console errors and warnings, CSP violations included. */
  consoleMessages: { level: "error" | "warning"; text: string }[];
  /** Requests that failed or answered 4xx/5xx. `status` is null when none came back. */
  failedRequests: { status: number | null; url: string }[];
  /** Library path of the screenshot saved in the run's task folder. */
  screenshotPath: string;
  /** Text snapshot of the page. */
  snapshot: string;
  title: string;
  version: number;
}

/**
 * Artifacts as the tools see them, bound to the run. A port throws `ToolError`
 * with `forbidden` for an artifact the run may not write, `not_found`, and
 * `conflict` for a stale `baseVersion` with the current version in the message.
 * `promote` answers `waiting` when a person must approve the version's grants.
 */
export interface ArtifactsPort {
  create: (input: ArtifactCreateInput) => Promise<ArtifactPublished>;
  list: (input: {
    cursor?: string;
    kind?: ArtifactKindInput;
  }) => Promise<{ items: ArtifactSummary[]; next?: string }>;
  promote: (input: {
    artifactId: string;
    version?: number;
  }) => Promise<
    | { status: "promoted"; version: number }
    | { status: "waiting"; version: number }
  >;
  read: (input: {
    artifactId: string;
    path?: string;
    version?: number;
  }) => Promise<ArtifactReadInfo>;
  test: (input: {
    artifactId: string;
    version?: number;
    viewport?: "desktop" | "phone";
  }) => Promise<ArtifactTestInfo>;
  update: (input: ArtifactUpdateInput) => Promise<ArtifactPublished>;
}

export interface WikiPageInfo {
  backlinks: { path: string; title: string }[];
  body: string;
  links: {
    index: number;
    slug: string;
    title: string;
    path: string;
    broken: boolean;
  }[];
  path: string;
  title: string;
}

/** What a `bash` call returns. A non-zero exit code is a normal result, not an error. */
export interface LibraryBashResult {
  exitCode: number;
  stderr: string;
  /** True when the library cut stderr at 64 KB. The text then ends with a truncation note. */
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  /** Library storage calls the script made. */
  storageCalls: number;
  wallMs: number;
}

/**
 * The owner of a skill. Names are unique per owner, so two skills can share a
 * name: show the owner wherever a name is shown. `agentId` is null for the people's skills.
 */
export interface SkillOwner {
  agentId: string | null;
  /** "people", or the owning agent's name. */
  name: string;
}

/** An agent that carries a skill. `version` is the one it uses now, the pinned one when `pinned`. */
export interface SkillAssignee {
  agentId: string;
  name: string;
  pinned: boolean;
  slug: string;
  version: number;
}

export interface SkillInfo {
  /** The agents that carry it with an approved version. */
  assignedTo: SkillAssignee[];
  id: string;
  /** The newest approved version, or null while none is approved. */
  latestApprovedVersion: number | null;
  /** The newest version that is not rejected. */
  latestVersion: number | null;
  name: string;
  owner: SkillOwner;
  /** The numbers of versions that wait for a person to approve them. */
  pendingProposals: number[];
}

/** One version of a skill. */
export interface SkillVersionInfo {
  /** Set once approved. */
  approvedAt: string | null;
  /** `user`, `agent` or `system`. */
  authorKind: string;
  createdAt: string;
  message: string;
  number: number;
  /** The version this one was made on, null for version 1. */
  parent: number | null;
  skillId: string;
  skillName: string;
  /** One of approved, proposed, rejected. */
  status: string;
}

export interface SkillFileInfo {
  executable: boolean;
  path: string;
  size: number;
}

/** A file's content: UTF-8 text, or base64 for a file that is not text. */
export interface SkillFileContent {
  content: string;
  encoding: "base64" | "utf8";
  path: string;
}

/** A version's file tree, and one file's content when a path was asked for. */
export interface SkillShown {
  file: SkillFileContent | null;
  files: SkillFileInfo[];
  version: SkillVersionInfo;
}

export interface SkillDiffInfo {
  added: string[];
  changed: string[];
  /** A unified diff of each added, removed or changed text file. */
  patches: { patch: string; path: string }[];
  removed: string[];
}

/** One file of a commit. `encoding` says how `content` is read. */
export interface SkillFileWrite {
  content: string;
  encoding: "base64" | "utf8";
  executable?: boolean;
  path: string;
}

export interface SkillAssignment {
  agentId: string;
  /** Null: the agent follows the latest approved version. */
  pinnedVersion: number | null;
  skillId: string;
}

export interface SkillImported {
  /** False when the archive made a new version of a skill the caller already owned. */
  created: boolean;
  name: string;
  version: SkillVersionInfo;
}

export interface SkillArchive {
  /** The `.skill` file, base64 encoded. */
  archiveBase64: string;
  filename: string;
}

/**
 * The channels the agent's Slack bot is in, and the people it may message.
 * `mention` is the text that makes a real Slack mention (`<#C…>` for a channel,
 * `<@U…>` for a person).
 */
export interface SlackDestinations {
  channels: { id: string; isPrivate: boolean; mention: string; name: string }[];
  people: {
    email: string;
    mention: string;
    slackName: string;
    slackUserId: string;
  }[];
}

/** A message read from Slack. `time` is ISO 8601, `threadTs` is null outside a thread. */
export interface SlackHistoryMessage {
  author: string;
  text: string;
  threadTs: string | null;
  time: string;
  ts: string;
}

/** Messages of one channel or thread, oldest first. `nextCursor` reads the next page. */
export interface SlackHistory {
  channel: string;
  messages: SlackHistoryMessage[];
  nextCursor: string | null;
}

/** A stored message that matched a search. */
export interface SlackSearchHit {
  author: string;
  channel: string;
  text: string;
  threadTs: string | null;
  time: string;
  ts: string;
}

/** The matches of a search, newest first. */
export interface SlackSearchResult {
  hits: SlackSearchHit[];
}

/** A message slack_send started. `permalink` is null when Slack gave none. */
export interface SlackSendResult {
  channel: string;
  /** Remarks about the text, such as an @name that was sent as plain text. */
  notes: string[];
  permalink: string | null;
  /** The target as resolved: `#name`, or a person's email. */
  to: string;
  ts: string;
}

/** Mailbox shapes mirror V5.1 without importing services into this package. */
export interface MailAddress {
  address: string;
  name?: string;
}

export interface MailThreadSummary {
  lastMessageAt: string;
  messageCount: number;
  participants: string[];
  subject: string;
  threadId: string;
  unreadCount: number;
}

export interface MailAttachmentMeta {
  contentId?: string;
  disposition: string;
  filename: string;
  id: string;
  mimetype: string;
  size: number;
}

export interface MailThreadMessage {
  attachments: MailAttachmentMeta[];
  cc: MailAddress[];
  date: string;
  folder: string;
  from: MailAddress;
  html: string | null;
  messageId: string;
  /** The approval or delivery outcome. The app adapter fills it from the D1 message status (V5.7). */
  status?: string;
  subject: string;
  text: string | null;
  to: MailAddress[];
}

export interface MailThreadView {
  messages: MailThreadMessage[];
  threadId: string;
}

/** The caller cannot choose a sender: the bound service supplies the mailbox address. */
export interface MailDraft {
  cc: string[];
  html?: string;
  subject: string;
  text: string;
  to: string[];
}

// V5.1 defines SentMail and HeldMail separately. The MCP adapter tags them
// so a held draft is a normal result and never mistaken for a completed send.
export type MailSendResult =
  | {
      messageId: string;
      rfcMessageId: string;
      status: "sent";
      threadId: string;
    }
  | { messageId: string; status: "held"; threadId: string };

/** Transport failures are values; tools supply the action the agent should take next. */
export interface PortFailure {
  code:
    | "offline"
    | "desktop_unavailable"
    | "desktop_busy"
    | "human_in_control"
    | "timeout"
    | "validation"
    | "not_found"
    | "conflict";
  ok: false;
  reason?: string;
}
export type PortResult<T extends object> = ({ ok: true } & T) | PortFailure;

/** Base64 image content ready for MCP, with no runtime-specific binary objects. */
export interface ToolImage {
  data: string;
  mimeType: string;
}

/** Paths are absolute logical computer paths, resolved by the bound adapter. */
export interface ComputerPort {
  desktopInput: (input: {
    actions: DesktopAction[];
  }) => Promise<PortResult<{ applied?: number }>>;
  exec: (input: {
    command: string;
    timeout_ms: number;
  }) => Promise<
    PortResult<{ exitCode: number; stdout: string; stderr: string }>
  >;
  listDir: (input: { path: string }) => Promise<
    PortResult<{
      entries: { name: string; directory: boolean; size: number }[];
    }>
  >;
  /** `maxBytes` is the most the adapter should fetch; it still reports the file's full `size`. */
  readFile: (input: {
    maxBytes: number;
    path: string;
  }) => Promise<PortResult<{ content: string; size: number }>>;
  /** For native runtime tools; deliberately not registered as an MCP tool. */
  screenshot: () => Promise<PortResult<{ image: ToolImage }>>;
  writeFile: (input: {
    path: string;
    content: string;
  }) => Promise<PortResult<{ created: boolean; size: number }>>;
}

export interface BrowserSnapshot {
  links: { href: string; text: string }[];
  linksTruncated: boolean;
  text: string;
  textTruncated: boolean;
  title: string;
  url: string;
}

/** The adapter enforces public http(s) destinations, including redirects and DNS resolution. */
export interface BrowserPort {
  click: (input: {
    selector: string;
  }) => Promise<PortResult<{ snapshot: BrowserSnapshot }>>;
  fill: (input: {
    selector: string;
    value: string;
  }) => Promise<PortResult<{ selector: string; url: string }>>;
  navigate: (input: {
    url: string;
  }) => Promise<PortResult<{ snapshot: BrowserSnapshot }>>;
  screenshot: () => Promise<
    PortResult<{ image: ToolImage; pageUrl: string; url?: string }>
  >;
  snapshot: () => Promise<PortResult<{ snapshot: BrowserSnapshot }>>;
}

/** Board records mirror the service without storage or workspace details. */
export interface QaQuestionInfo {
  acceptedAnswerId: string | null;
  authorId: string;
  authorKind: QaAuthorKind;
  body: string;
  createdAt: string;
  id: string;
  runId: string | null;
  status: QaStatus;
  title: string;
  updatedAt: string;
}

export interface QaAnswerInfo {
  authorId: string;
  authorKind: QaAuthorKind;
  body: string;
  createdAt: string;
  id: string;
  questionId: string;
  runId: string | null;
}

/** Bound to the caller; adapters translate service failures to ToolError. */
export interface QaPort {
  answer: (input: { id: string; body: string }) => Promise<QaAnswerInfo>;
  ask: (input: { title: string; body: string }) => Promise<QaQuestionInfo>;
  get: (input: { id: string }) => Promise<{
    answers: QaAnswerInfo[];
    question: QaQuestionInfo;
  }>;
  list: (input: { cursor?: string; status?: QaStatus }) => Promise<{
    nextCursor: string | null;
    questions: QaQuestionInfo[];
  }>;
}

/** An agent as the admin tools show it. */
export interface AdminAgentInfo {
  id: string;
  model: string;
  name: string;
  runtime: string;
  slug: string;
}

/** A secret as the admin tools show it: never its value. `hosts` are the hosts it applies to. */
export interface AdminSecretInfo {
  hosts: string[];
  id: string;
  mode: "env" | "proxy";
  name: string;
}

/** An API key after it was made. `secret` is the only copy. */
export interface AdminKeyCreated {
  access: string;
  id: string;
  name: string;
  prefix: string;
  secret: string;
}

export interface AdminKeyRevoked {
  id: string;
  name: string;
  revokedAt: string | null;
}

/** One header rule of a proxy secret. `template` holds the `{value}` placeholder. */
export interface AdminSecretRule {
  header: string;
  host: string;
  template: string;
}

/**
 * The setup calls for an `hm_key_` key (X.10). Offered only to a write key
 * (`createAgent`, `updateAgent`, `createInboxThread`) or an admin key (all).
 * `agent` is a slug or an id.
 */
export interface AdminPort {
  createAgent: (input: {
    connectors?: string[];
    environment?: "isolate" | "linux-vm";
    instructions?: string;
    machineId?: string;
    maxTurns?: number;
    model: string;
    name: string;
    networkAccess?: boolean;
    runtime: "cloud" | "machine" | "managed";
    slug?: string;
  }) => Promise<AdminAgentInfo>;
  createApiKey: (input: {
    access: "admin" | "desk" | "read" | "write";
    name: string;
  }) => Promise<AdminKeyCreated>;
  createEnrolmentCode: (input: {
    machineId?: string;
    machineName?: string;
    role?: "agent_host" | "computer";
  }) => Promise<{ code: string; expiresAt: string }>;
  createInboxThread: (input: { title: string }) => Promise<ThreadInfo>;
  createSecret: (
    input:
      | { allowedHosts?: string[]; mode: "env"; name: string; value: string }
      | {
          mode: "proxy";
          name: string;
          rules: AdminSecretRule[];
          value: string;
        }
  ) => Promise<AdminSecretInfo>;
  deleteConnector: (input: { connectorId: string }) => Promise<void>;
  grantSecret: (input: { agent: string; secretId: string }) => Promise<void>;
  revokeApiKey: (input: { keyId: string }) => Promise<AdminKeyRevoked>;
  revokeSecret: (input: { agent: string; secretId: string }) => Promise<void>;
  updateAgent: (input: {
    agent: string;
    connectors?: string[];
    environment?: "isolate" | "linux-vm";
    instructions?: string;
    machineId?: string | null;
    maxTurns?: number;
    model?: string;
    name?: string;
    networkAccess?: boolean;
    slug?: string;
  }) => Promise<AdminAgentInfo>;
}

export interface McpPorts {
  /** Set for every key principal; the server offers the tools its access allows. */
  admin?: AdminPort;
  approveSkillVersion: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillVersionInfo>;
  /** Set once the app wires artifacts; the artifact tools are offered only then. */
  artifacts?: ArtifactsPort;
  assignSkill: (input: {
    agent: string;
    skillId: string;
  }) => Promise<SkillAssignment>;
  browser?: BrowserPort;
  /** Cancels a queued, offered or running run and returns the run as it is afterwards. */
  cancelRun: (input: { runId: string }) => Promise<RunInfo>;
  commitSkill: (input: {
    baseVersion: number;
    deletes: string[];
    message: string;
    skillId: string;
    writes: SkillFileWrite[];
  }) => Promise<SkillVersionInfo>;
  computer?: ComputerPort;
  createRoutine: (input: {
    agentId: string;
    cron: string;
    name: string;
    prompt: string;
    timezone?: string;
  }) => Promise<RoutineInfo>;
  createSkill: (input: {
    files: SkillFileWrite[];
    message: string;
    name: string;
  }) => Promise<SkillVersionInfo>;
  createTrigger: (input: {
    agentId: string;
    name: string;
  }) => Promise<TriggerChange>;
  deleteRoutine: (input: { routineId: string }) => Promise<void>;
  /** Removes a skill with all its versions, files and assignments. */
  deleteSkill: (input: { skillId: string }) => Promise<void>;
  deleteTrigger: (input: { triggerId: string }) => Promise<void>;
  exportSkill: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillArchive>;
  getRun: (input: { runId: string }) => Promise<RunInfo>;
  importSkill: (input: { archiveBase64: string }) => Promise<SkillImported>;
  inboxList: () => Promise<ThreadInfo[]>;
  inboxPost: (input: { text: string; threadId: string }) => Promise<PostedInfo>;
  inboxRead: (input: { threadId: string }) => Promise<ThreadTranscript>;
  /** Runs a bash script over the workspace file library. */
  libraryBash: (input: { script: string }) => Promise<LibraryBashResult>;
  /** Adapters normalize paths, enforce caller access and translate service failures to ToolError. */
  libraryList: (input: { dir: string }) => Promise<LibraryEntryInfo[]>;
  libraryRead: (input: {
    path: string;
  }) => Promise<{ bytes: Uint8Array; entry: LibraryEntryInfo }>;
  libraryVersions: (input: { path: string }) => Promise<LibraryVersionInfo[]>;
  libraryWrite: (input: {
    path: string;
    bytes: Uint8Array;
    ifEtag?: string;
  }) => Promise<LibraryEntryInfo>;
  listAgents: () => Promise<AgentInfo[]>;
  listRoutines: (input: { agentId?: string }) => Promise<RoutineInfo[]>;
  listSessions: (input: { agent: string }) => Promise<SessionInfo[]>;
  listSkills: () => Promise<SkillInfo[]>;
  listTriggers: (input: { agentId?: string }) => Promise<TriggerInfo[]>;
  /** Bound to the calling run's active mailbox; absent for other principals. */
  mail?: {
    list: (input: {
      limit: number;
      page: number;
    }) => Promise<MailThreadSummary[]>;
    read: (input: { threadId: string }) => Promise<MailThreadView | null>;
    reply: (input: MailDraft & { threadId: string }) => Promise<MailSendResult>;
    send: (input: MailDraft) => Promise<MailSendResult>;
  };
  pinSkill: (input: {
    agent: string;
    skillId: string;
    version: number | null;
  }) => Promise<SkillAssignment>;
  qa?: QaPort;
  readSession: (input: { sessionId: string }) => Promise<SessionTranscript>;
  rejectSkillVersion: (input: {
    skillId: string;
    version: number;
  }) => Promise<SkillVersionInfo>;
  revertSkill: (input: {
    message?: string;
    skillId: string;
    toVersion: number;
  }) => Promise<SkillVersionInfo>;
  searchSessions: (input: {
    agent: string;
    query: string;
  }) => Promise<SearchHit[]>;
  /** Starts a run and waits up to `waitMs` (0 to 25000) for it to finish. */
  sendMessage: (input: {
    agent: string;
    requestId?: string;
    text: string;
    waitMs: number;
  }) => Promise<RunInfo>;
  setRoutineEnabled: (input: {
    enabled: boolean;
    routineId: string;
  }) => Promise<RoutineInfo>;
  setTriggerEnabled: (input: {
    enabled: boolean;
    triggerId: string;
  }) => Promise<TriggerChange>;
  skillDiff: (input: {
    from: number;
    skillId: string;
    to: number;
  }) => Promise<SkillDiffInfo>;
  skillLog: (input: { skillId: string }) => Promise<SkillVersionInfo[]>;
  /** The version's tree, and the content of `path` when it is given. */
  skillShow: (input: {
    path?: string;
    skillId: string;
    version: number;
  }) => Promise<SkillShown>;
  slackDestinations: () => Promise<SlackDestinations>;
  slackHistory: (input: {
    channel: string;
    cursor?: string;
    limit?: number;
    since?: string;
    thread_ts?: string;
    until?: string;
  }) => Promise<SlackHistory>;
  slackSearch: (input: {
    channel?: string;
    limit?: number;
    person?: string;
    query: string;
    since?: string;
    until?: string;
  }) => Promise<SlackSearchResult>;
  slackSend: (input: {
    text: string;
    thread_ts?: string;
    to: string;
  }) => Promise<SlackSendResult>;
  unassignSkill: (input: { agent: string; skillId: string }) => Promise<void>;
  wikiRead: (input: { path: string }) => Promise<WikiPageInfo>;
  wikiSuggestEdit: (input: {
    path: string;
    body: string;
    summary: string;
  }) => Promise<{ id: string }>;
}

/** The longest a send_message call waits, in milliseconds. */
export const SEND_WAIT_MAX_MS = 25_000;
