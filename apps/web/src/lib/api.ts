import type { ActivityView as ActivityRow } from "#/modules/activity/service";
import type { AgentView } from "#/modules/agents/service";
import type { ChannelBridge as ChannelBridgeRow } from "#/modules/bridges/schema";
import type { SlackAppView as SlackAppRow } from "#/modules/bridges/slack/apps";
import type {
  BrowserStatus as BrowserStatusRow,
  StoredScreenshot as ScreenshotRow,
} from "#/modules/browser/types";
import type { DirEntry as DirEntryRow } from "#/modules/computer/types";
import type {
  ConnectorView as ConnectorRow,
  StartOutcome as StartOutcomeRow,
} from "#/modules/connectors/service";

import type { Channel as ChannelRow } from "#/modules/messaging/schema";
import type {
  AttachmentView as AttachmentRow,
  ChannelMemberView as ChannelMemberRow,
  MessageView as MessageRow,
} from "#/modules/messaging/service";
import type {
  QuestionAnswererView,
  QuestionView,
} from "#/modules/questions/view";
import type { Schedule as ScheduleShape } from "#/modules/routines/schedule";
import type {
  RoutineView as RoutineRow,
  RoutineRunView as RoutineRunRow,
} from "#/modules/routines/service";
import type {
  SkillFileView as SkillFileRow,
  SkillView as SkillRow,
  SkillVersionView as SkillVersionRow,
} from "#/modules/skills/service";
import type {
  WikiPageSummary as WikiPageSummaryRow,
  WikiPageView,
  WikiRevisionView,
} from "#/modules/wiki/service";
import type { WorkspaceRole } from "#/modules/workspaces/schema";
import type {
  MemberView as MemberRow,
  WorkspaceView as WorkspaceRow,
} from "#/modules/workspaces/service";

/** The client speaks exactly the server's shapes; these aliases are the contract. */
/**
 * `pendingQuestions` is optional because only the list carries it: the single
 * agent responses (create, edit, read) are about the agent, not about what it
 * happens to be waiting on. The rail's status poll carries it too.
 */
export type Agent = AgentView & { pendingQuestions?: number };
export type ActivityView = ActivityRow;
export type BrowserStatus = BrowserStatusRow;
export type Channel = ChannelRow;
export type Connector = ConnectorRow;
export type ConnectorStatus = Connector["status"];
/** What the add-connector dialog must do next; see the ladder in plan 4b. */
export type StartOutcome = StartOutcomeRow;
export type DirEntry = DirEntryRow;
export type MemberView = MemberRow;
/**
 * Somebody who writes from a bridged surface. `memberId` is who they are here,
 * once that has been worked out - by the email match (`linkSource: "auto"`) or
 * by somebody saying so (`"manual"`).
 */
export interface ExternalAuthorView {
  authorId: string;
  displayName: string;
  linkSource: "auto" | "manual" | null;
  memberId: string | null;
}
export type Screenshot = ScreenshotRow;
export type AttachmentView = AttachmentRow;
export type ChannelMemberView = ChannelMemberRow;
export type MessageView = MessageRow;
/** An agent's question, as the card in the message stream renders it. */
export type Question = QuestionView;
export type QuestionStatus = Question["status"];
export type QuestionKind = Question["kind"];
export type QuestionAnswerer = QuestionAnswererView;
export type Routine = RoutineRow;
export type RoutineRun = RoutineRunRow;
export type RoutineRunStatus = RoutineRun["status"];
/** The structured schedule, as both the picker and the scheduler read it. */
export type Schedule = ScheduleShape;
export type Skill = SkillRow;
export type SkillSyncStatus = Skill["syncStatus"];
export type SkillVersion = SkillVersionRow;
export type SkillFile = SkillFileRow;
export type WikiPage = WikiPageView;
export type WikiPageSummary = WikiPageSummaryRow;
export type WikiRevision = WikiRevisionView;
export type WorkspaceView = WorkspaceRow;

/** Carries the HTTP status so callers can tell "missing" from "broken". */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const NOT_FOUND = 404;
const CONFLICT = 409;

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === NOT_FOUND;

/** Server error bodies are `{ error }`; anything else is a transport failure. */
const failureOf = async (response: Response): Promise<ApiError> => {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new ApiError(
    body?.error ?? `Request failed (${response.status}).`,
    response.status
  );
};

const fetchJson = async <T>(
  url: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> => {
  const { json, ...rest } = init ?? {};
  const response = await fetch(url, {
    ...rest,
    ...(json === undefined
      ? {}
      : {
          body: JSON.stringify(json),
          headers: { "content-type": "application/json" },
        }),
  });

  if (!response.ok) {
    throw await failureOf(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
};

// --- workspaces (not scoped to one) -----------------------------------------

/**
 * The caller's own membership in a workspace. `memberId` is the only identity
 * the client has for itself - `authors.ts` compares message authors against it,
 * since a Clerk id never reaches the browser.
 */
export interface Membership {
  memberId: string;
  role: WorkspaceRole;
}

/** A workspace as the caller sees it: the row plus how they belong to it. */
export interface WorkspaceMembership {
  membership: Membership;
  workspace: WorkspaceView;
}

/** Every workspace the caller belongs to - the switcher's source. */
export const listWorkspaces = () =>
  fetchJson<{ workspaces: WorkspaceMembership[] }>("/api/workspaces").then(
    (data) => data.workspaces
  );

/** 502 here means Clerk could not be read; its message is worth showing. */
export const createWorkspace = (name: string) =>
  fetchJson<WorkspaceMembership>("/api/workspaces", {
    json: { name },
    method: "POST",
  });

// --- everything inside one workspace ----------------------------------------

/** Just enough of an agent to render a chip or a checkbox row. */
export interface ConnectorAgentRef {
  avatar: string;
  id: string;
  name: string;
}

export interface AgentInput {
  instructions: string;
  /** A catalog model id, or null for the workspace default. */
  model?: string | null;
  name: string;
  soul: string;
}

/** The MCP URL is returned once, when the token behind it is issued. */
export interface IssuedAgent {
  agent: Agent;
  mcpUrl: string;
}

/** What the router and the Anthropic registration currently say about an agent. */
export interface AgentStatusView {
  agentId: string;
  /** Questions this agent is waiting on - the rail's badge. */
  pendingQuestions: number;
  sessionId: string | null;
  status: Agent["status"];
  syncError: string | null;
  syncStatus: Agent["syncStatus"];
}

export interface ActivityPage {
  entries: ActivityView[];
  nextCursor: string | null;
}

export interface ComputerFile {
  content: string;
  path: string;
  size: number;
}

export interface ScreenshotPage {
  nextCursor: string | null;
  screenshots: Screenshot[];
}

export interface CategoryItemRef {
  itemId: string;
  itemType: "agent" | "channel";
}

export interface CategoryView {
  id: string;
  items: CategoryItemRef[];
  name: string;
}

export interface WikiAssetView {
  filename: string;
  id: string;
  mime: string;
  size: number;
  url: string;
}

export interface ConnectorTestResult {
  message: string | null;
  ok: boolean;
  tools: { description: string | null; name: string }[];
}

/** A skill the agent holds, plus how it tracks it: a version, or latest. */
export interface AssignedSkill extends Skill {
  pinnedVersion: number | null;
}

/** An agent that holds a skill, for the detail view's list. */
export interface SkillAgentRef extends ConnectorAgentRef {
  pinnedVersion: number | null;
}

/** One version's whole file set, as the editor and the API both speak it. */
export interface SkillFileInput {
  content: string;
  path: string;
}

export interface SkillDetail {
  files: SkillFile[];
  skill: Skill;
  /** The version being viewed - the latest unless one was asked for. */
  version: SkillVersion;
  versions: SkillVersion[];
}

export interface PublishedSkill {
  skill: Skill;
  version: SkillVersion;
}

/** Everything a routine needs to exist; the API takes the same shape partially. */
export interface RoutineInput {
  agentId: string;
  channelId: string;
  instructions: string;
  /** A catalog model id, or null for whatever the agent itself runs on. */
  model?: string | null;
  name: string;
  schedule: Schedule;
  timezone: string;
}

/** A routine plus the newest page of its history. */
export interface RoutineDetail {
  routine: Routine;
  runs: RoutineRun[];
}

/** `nextBefore` is the next page's `before`, or null at the end of history. */
export interface RoutineRunPage {
  nextBefore: number | null;
  runs: RoutineRun[];
}

export type ChannelBridge = ChannelBridgeRow;
export type SlackApp = SlackAppRow;

/**
 * What the wizard needs to show an agent's connection: the row, plus the
 * manifest to paste into Slack and the events URL it names. The manifest comes
 * back with every read, not just the create, so the wizard is resumable.
 */
export interface SlackAppSetup {
  manifest: string;
  requestUrl: string;
  slackApp: SlackApp;
}

/** Who an email belongs to, before adding them as a member. */
export interface MemberSearchResult {
  email: string;
  exists: boolean;
  imageUrl: string | null;
  name: string | null;
}

/**
 * Every resource endpoint lives under `/api/w/:slug`, so the client is bound to
 * one workspace rather than reading an ambient "current" one: a module-level
 * slug would be shared across concurrent server renders, and the whole point of
 * this layer is that a request cannot address the wrong tenant.
 *
 * `useApi()` (lib/workspace-context) hands components the instance for the
 * workspace in the route.
 */
export const createApi = (workspaceSlug: string) => {
  const apiBase = `/api/w/${encodeURIComponent(workspaceSlug)}`;

  const request = <T>(path: string, init?: RequestInit & { json?: unknown }) =>
    fetchJson<T>(`${apiBase}${path}`, init);

  /** For the endpoints that answer with a file's bytes rather than JSON. */
  const requestText = async (path: string): Promise<string> => {
    const response = await fetch(`${apiBase}${path}`);
    if (!response.ok) {
      throw await failureOf(response);
    }
    return await response.text();
  };

  // --- the workspace itself -------------------------------------------------

  const getWorkspace = () =>
    request<{ membership: Membership; workspace: WorkspaceView }>("");

  const renameWorkspace = (name: string) =>
    request<{ membership: Membership; workspace: WorkspaceView }>("", {
      json: { name },
      method: "PATCH",
    }).then((data) => data.workspace);

  const deleteWorkspace = () => request<void>("", { method: "DELETE" });

  const listMembers = () =>
    request<{ members: MemberView[] }>("/members").then((data) => data.members);

  /** Owner-only: the Clerk lookup behind "add by email". */
  const searchMember = (email: string) =>
    request<MemberSearchResult>(
      `/members/search?email=${encodeURIComponent(email)}`
    );

  const addMember = (email: string, role: WorkspaceRole = "member") =>
    request<{ member: MemberView }>("/members", {
      json: { email, role },
      method: "POST",
    }).then((data) => data.member);

  /** Everyone a bridged surface has seen post, and who they are. */
  const listExternalAuthors = () =>
    request<{ authors: ExternalAuthorView[] }>("/external-authors").then(
      (data) => data.authors
    );

  /** Owner-only. `memberId: null` takes the answer back. */
  const linkExternalAuthor = (authorId: string, memberId: string | null) =>
    request<void>(`/external-authors/${encodeURIComponent(authorId)}`, {
      json: { memberId },
      method: "PATCH",
    });

  const setMemberRole = (memberId: string, role: WorkspaceRole) =>
    request<{ member: MemberView }>(
      `/members/${encodeURIComponent(memberId)}`,
      { json: { role }, method: "PATCH" }
    ).then((data) => data.member);

  const removeMember = (memberId: string) =>
    request<void>(`/members/${encodeURIComponent(memberId)}`, {
      method: "DELETE",
    });

  // --- agents ---------------------------------------------------------------

  const listAgents = () =>
    request<{ agents: Agent[] }>("/agents").then((data) => data.agents);

  const createAgent = (input: AgentInput) =>
    request<IssuedAgent>("/agents", { json: input, method: "POST" });

  const updateAgent = (id: string, input: AgentInput) =>
    request<{ agent: Agent }>(`/agents/${id}`, {
      json: input,
      method: "PATCH",
    }).then((data) => data.agent);

  /** Invalidates the agent's current MCP URL and returns its replacement. */
  const rotateAgentMcpToken = (id: string) =>
    request<IssuedAgent>(`/agents/${id}`, {
      json: { rotateMcpToken: true },
      method: "PATCH",
    });

  const deleteAgent = (id: string) =>
    request<void>(`/agents/${id}`, { method: "DELETE" });

  const getAgentStatus = (id: string) =>
    request<{ status: AgentStatusView }>(`/agents/${id}/status`).then(
      (data) => data.status
    );

  // --- the agent's screen: activity, computer, browser ----------------------

  /** Newest first; `before` is the `nextCursor` of the page before it. */
  const listAgentActivity = (
    id: string,
    options: { before?: string; limit?: number } = {}
  ) => {
    const query = new URLSearchParams();
    if (options.before) {
      query.set("before", options.before);
    }
    if (options.limit) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return request<ActivityPage>(`/agents/${id}/activity${suffix}`);
  };

  const listComputerDir = (id: string, path: string) =>
    request<{ entries: DirEntry[] }>(
      `/agents/${id}/computer/ls?path=${encodeURIComponent(path)}`
    ).then((data) => data.entries);

  /** The raw endpoint, for the "this file will not preview" download link. */
  const computerFileUrl = (id: string, path: string): string =>
    `${apiBase}/agents/${id}/computer/file?path=${encodeURIComponent(path)}`;

  const readComputerFile = (id: string, path: string) =>
    request<ComputerFile>(
      `/agents/${id}/computer/file?path=${encodeURIComponent(path)}`
    );

  /** The user putting a file onto the agent's computer, from the Files tab. */
  const uploadComputerFile = async (
    id: string,
    file: File,
    path: string
  ): Promise<{ path: string; size: number }> => {
    const form = new FormData();
    form.append("file", file);
    form.append("path", path);
    const data = await request<{ file: { path: string; size: number } }>(
      `/agents/${id}/computer/file`,
      { body: form, method: "POST" }
    );
    return data.file;
  };

  const listBrowserScreenshots = (id: string, limit: number) =>
    request<ScreenshotPage>(`/agents/${id}/browser/screenshots?limit=${limit}`);

  const getBrowserStatus = (id: string) =>
    request<BrowserStatus>(`/agents/${id}/browser/status`);

  // --- channels -------------------------------------------------------------

  const listChannels = () =>
    request<{ channels: Channel[] }>("/channels").then((data) => data.channels);

  const createChannel = (input: { agentIds: string[]; name: string }) =>
    request<{ channel: Channel }>("/channels", {
      json: input,
      method: "POST",
    }).then((data) => data.channel);

  /** DMs are one-per-agent; the server reuses the existing channel if there is one. */
  const openAgentDm = (agentId: string) =>
    request<{ channel: Channel }>("/channels", {
      json: { agentId, kind: "dm" },
      method: "POST",
    }).then((data) => data.channel);

  const getChannel = (id: string) =>
    request<{ channel: Channel; members: ChannelMemberView[] }>(
      `/channels/${id}`
    );

  const listMessages = (id: string, cursor?: string) =>
    request<{ messages: MessageView[]; nextCursor: string | null }>(
      `/channels/${id}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    );

  const postMessage = (
    channelId: string,
    input: { attachmentIds?: string[]; body: string; threadParentId?: string }
  ) =>
    request<{ message: MessageView }>(`/channels/${channelId}/messages`, {
      json: input,
      method: "POST",
    }).then((data) => data.message);

  const addChannelMember = (
    channelId: string,
    member: { memberId: string; memberType: "agent" | "user" }
  ) =>
    request<{ members: ChannelMemberView[] }>(
      `/channels/${channelId}/members`,
      {
        json: member,
        method: "POST",
      }
    ).then((data) => data.members);

  const removeChannelMember = (
    channelId: string,
    memberType: "agent" | "user",
    memberId: string
  ) =>
    request<{ members: ChannelMemberView[] }>(
      `/channels/${channelId}/members/${memberType}/${encodeURIComponent(memberId)}`,
      { method: "DELETE" }
    ).then((data) => data.members);

  /** The socket the open channel listens on; the session cookie rides the upgrade. */
  const channelSocketUrl = (channelId: string): string => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}${apiBase}/channels/${channelId}/ws`;
  };

  // --- categories -----------------------------------------------------------

  const listCategories = () =>
    request<{ categories: CategoryView[] }>("/categories").then(
      (data) => data.categories
    );

  const createCategory = (name: string) =>
    request<{ category: CategoryView }>("/categories", {
      json: { name },
      method: "POST",
    }).then((data) => data.category);

  const renameCategory = (id: string, name: string) =>
    request<{ category: CategoryView }>(`/categories/${id}`, {
      json: { name },
      method: "PATCH",
    }).then((data) => data.category);

  const deleteCategory = (id: string) =>
    request<void>(`/categories/${id}`, { method: "DELETE" });

  /** An item lives in at most one category, so assigning moves it. */
  const assignCategoryItem = (categoryId: string, item: CategoryItemRef) =>
    request<void>(`/categories/${categoryId}/items`, {
      json: item,
      method: "PUT",
    });

  const unassignCategoryItem = (categoryId: string, item: CategoryItemRef) =>
    request<void>(
      `/categories/${categoryId}/items/${item.itemType}/${encodeURIComponent(item.itemId)}`,
      { method: "DELETE" }
    );

  // --- threads & attachments ------------------------------------------------

  const getThread = (messageId: string) =>
    request<{ parent: MessageView; replies: MessageView[] }>(
      `/messages/${messageId}/thread`
    );

  const uploadAttachment = async (file: File): Promise<AttachmentView> => {
    const form = new FormData();
    form.append("file", file);
    const data = await request<{ attachment: AttachmentView }>("/attachments", {
      body: form,
      method: "POST",
    });
    return data.attachment;
  };

  // --- wiki -----------------------------------------------------------------

  const listWikiPages = () =>
    request<{ pages: WikiPageSummary[] }>("/wiki").then((data) => data.pages);

  const getWikiPage = (slug: string) =>
    request<{ page: WikiPage }>(`/wiki/${encodeURIComponent(slug)}`).then(
      (data) => data.page
    );

  const createWikiPage = (input: { body: string; title: string }) =>
    request<{ page: WikiPage }>("/wiki", { json: input, method: "POST" }).then(
      (data) => data.page
    );

  const updateWikiPage = (
    slug: string,
    input: { body?: string; title?: string }
  ) =>
    request<{ page: WikiPage }>(`/wiki/${encodeURIComponent(slug)}`, {
      json: input,
      method: "PATCH",
    }).then((data) => data.page);

  const deleteWikiPage = (slug: string) =>
    request<void>(`/wiki/${encodeURIComponent(slug)}`, { method: "DELETE" });

  const listWikiRevisions = (slug: string) =>
    request<{ revisions: WikiRevision[] }>(
      `/wiki/${encodeURIComponent(slug)}/revisions`
    ).then((data) => data.revisions);

  const getWikiRevision = (slug: string, revisionId: string) =>
    request<{ revision: WikiRevision }>(
      `/wiki/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}`
    ).then((data) => data.revision);

  const uploadWikiAsset = async (
    file: File,
    pageId?: string
  ): Promise<WikiAssetView> => {
    const form = new FormData();
    form.append("file", file);
    if (pageId) {
      form.append("pageId", pageId);
    }
    const data = await request<{ asset: WikiAssetView }>("/wiki/assets", {
      body: form,
      method: "POST",
    });
    return data.asset;
  };

  // --- connectors -----------------------------------------------------------

  const listConnectors = () =>
    request<{ connectors: Connector[] }>("/connectors").then(
      (data) => data.connectors
    );

  /** The agent rail's chips and the settings picker's ticked boxes. */
  const listAgentConnectors = (agentId: string) =>
    request<{ connectors: Connector[] }>(
      `/connectors?agentId=${encodeURIComponent(agentId)}`
    ).then((data) => data.connectors);

  const getConnector = (id: string) =>
    request<{ agents: ConnectorAgentRef[]; connector: Connector }>(
      `/connectors/${id}`
    );

  /**
   * The pasted URL is probed server-side, so the outcome - not the connector -
   * is what the dialog acts on. The row exists either way, which is what makes
   * an abandoned OAuth attempt resumable from the connector's detail view.
   */
  const addConnector = (input: { name?: string; url: string }) =>
    request<{ connector: Connector; outcome: StartOutcome }>("/connectors", {
      json: input,
      method: "POST",
    });

  const renameConnector = (id: string, name: string) =>
    request<{ connector: Connector }>(`/connectors/${id}`, {
      json: { name },
      method: "PATCH",
    }).then((data) => data.connector);

  const setConnectorDisabled = (id: string, disabled: boolean) =>
    request<{ connector: Connector }>(`/connectors/${id}`, {
      json: { disabled },
      method: "PATCH",
    }).then((data) => data.connector);

  /** Archives the vault credential too; `vaultError` reports a partial failure. */
  const removeConnector = (id: string) =>
    request<{ removed: boolean; vaultError: string | null }>(
      `/connectors/${id}`,
      { method: "DELETE" }
    );

  /** Rung 3's manual branch: the server has no dynamic client registration. */
  const setConnectorOauthClient = (
    id: string,
    input: { clientId: string; clientSecret?: string | null }
  ) =>
    request<{ outcome: StartOutcome }>(`/connectors/${id}/oauth/client`, {
      json: input,
      method: "POST",
    }).then((data) => data.outcome);

  const reauthorizeConnector = (id: string) =>
    request<{ outcome: StartOutcome }>(`/connectors/${id}/reauthorize`, {
      method: "POST",
    }).then((data) => data.outcome);

  /** Rung 6: no usable OAuth, so a pasted token becomes a static credential. */
  const setConnectorBearer = (id: string, token: string) =>
    request<{ connector: Connector }>(`/connectors/${id}/bearer`, {
      json: { token },
      method: "POST",
    }).then((data) => data.connector);

  /** Re-probes the server now and refreshes the cached tool list with it. */
  const testConnector = (id: string) =>
    request<{ connector: Connector; result: ConnectorTestResult }>(
      `/connectors/${id}/test`,
      { method: "POST" }
    );

  const listConnectorAgents = (id: string) =>
    request<{ agents: ConnectorAgentRef[] }>(`/connectors/${id}/agents`).then(
      (data) => data.agents
    );

  /** Takes effect on the agent's *next* session - `vault_ids` is create-only. */
  const assignConnectorToAgent = (id: string, agentId: string) =>
    request<{ appliesToNextSession: boolean; assigned: boolean }>(
      `/connectors/${id}/agents`,
      { json: { agentId }, method: "POST" }
    );

  const unassignConnectorFromAgent = (id: string, agentId: string) =>
    request<void>(`/connectors/${id}/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });

  // --- skills ---------------------------------------------------------------

  const listSkills = () =>
    request<{ skills: Skill[] }>("/skills").then((data) => data.skills);

  /** The rail's chips and the settings picker's ticked boxes. */
  const listAgentSkills = (agentId: string) =>
    request<{ skills: AssignedSkill[] }>(
      `/skills?agentId=${encodeURIComponent(agentId)}`
    ).then((data) => data.skills);

  const getSkill = (slug: string, version?: number) =>
    request<SkillDetail>(
      `/skills/${encodeURIComponent(slug)}${version === undefined ? "" : `?version=${version}`}`
    );

  /** The raw endpoint, for a file's download link. */
  const skillFileUrl = (slug: string, version: number, path: string): string =>
    `${apiBase}/skills/${encodeURIComponent(slug)}/versions/${version}/file?path=${encodeURIComponent(path)}`;

  const readSkillFile = (slug: string, version: number, path: string) =>
    requestText(
      `/skills/${encodeURIComponent(slug)}/versions/${version}/file?path=${encodeURIComponent(path)}`
    );

  const createSkill = (input: {
    changelog?: string;
    files: SkillFileInput[];
    slug: string;
  }) => request<PublishedSkill>("/skills", { json: input, method: "POST" });

  /** A full file set plus the "why" - never a patch of the version before it. */
  const createSkillVersion = (
    slug: string,
    input: { changelog: string; files: SkillFileInput[] }
  ) =>
    request<PublishedSkill>(`/skills/${encodeURIComponent(slug)}/versions`, {
      json: input,
      method: "POST",
    });

  /** Pushes the local versions at Anthropic again after a failed publish. */
  const retrySkillSync = (slug: string) =>
    request<{ skill: Skill }>(
      `/skills/${encodeURIComponent(slug)}/retry-sync`,
      { method: "POST" }
    ).then((data) => data.skill);

  /** Unassigns it from every agent, then deletes both mirrors. */
  const deleteSkill = (slug: string) =>
    request<{ anthropicError: string | null; removed: boolean }>(
      `/skills/${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    );

  const listSkillAgents = (slug: string) =>
    request<{ agents: SkillAgentRef[] }>(
      `/skills/${encodeURIComponent(slug)}/agents`
    ).then((data) => data.agents);

  /** `pinnedVersion` null tracks latest, which is how a fix propagates (plan 5d). */
  const assignSkillToAgent = (
    slug: string,
    agentId: string,
    pinnedVersion: number | null
  ) =>
    request<{ assigned: boolean; outcome: string }>(
      `/skills/${encodeURIComponent(slug)}/agents`,
      { json: { agentId, pinnedVersion }, method: "POST" }
    );

  const unassignSkillFromAgent = (slug: string, agentId: string) =>
    request<void>(
      `/skills/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );

  // --- routines -------------------------------------------------------------

  const listRoutines = () =>
    request<{ routines: Routine[] }>("/routines").then((data) => data.routines);

  /** The routine and the 20 newest runs, which is what the detail view opens on. */
  const getRoutine = (id: string) => request<RoutineDetail>(`/routines/${id}`);

  const createRoutine = (input: RoutineInput) =>
    request<{ routine: Routine }>("/routines", {
      json: input,
      method: "POST",
    }).then((data) => data.routine);

  /** Partial: the enabled toggle and a full edit are the same endpoint. */
  const updateRoutine = (
    id: string,
    input: Partial<RoutineInput> & { enabled?: boolean }
  ) =>
    request<{ routine: Routine }>(`/routines/${id}`, {
      json: input,
      method: "PATCH",
    }).then((data) => data.routine);

  const deleteRoutine = (id: string) =>
    request<void>(`/routines/${id}`, { method: "DELETE" });

  /** Newest first; `before` is the `nextBefore` of the page before it. */
  const listRoutineRuns = (
    id: string,
    options: { before?: number; limit?: number } = {}
  ) => {
    const query = new URLSearchParams();
    if (options.before !== undefined) {
      query.set("before", String(options.before));
    }
    if (options.limit) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return request<RoutineRunPage>(`/routines/${id}/runs${suffix}`);
  };

  /** "Run now": fires the routine without touching its next scheduled slot. */
  const runRoutine = (id: string) =>
    request<{ run: RoutineRun }>(`/routines/${id}/run`, {
      method: "POST",
    }).then((data) => data.run);

  // --- questions ------------------------------------------------------------

  /** Everything still waiting on a human, for the workspace-wide badge. */
  const listPendingQuestions = () =>
    request<{ questions: Question[] }>("/questions?status=pending").then(
      (data) => data.questions
    );

  /** One agent's questions, newest first - answered and expired ones included. */
  const listAgentQuestions = (agentId: string) =>
    request<{ questions: Question[] }>(
      `/agents/${encodeURIComponent(agentId)}/questions`
    ).then((data) => data.questions);

  /**
   * Answering, with losing the race as a *result* rather than an exception.
   *
   * First answer wins (plan decision 3), so a 409 is an ordinary outcome of
   * pressing a button somebody else pressed first - and its body carries the
   * winner's question view, which is exactly what the card must now show. An
   * `ApiError` would throw that away, so this one endpoint answers in a union.
   * A 400 (an option that is not on offer) still throws: that is a bug, not a
   * race.
   */
  const answerQuestion = async (
    id: string,
    answer: string
  ): Promise<
    | { ok: false; error: string; question: Question | null }
    | { ok: true; question: Question }
  > => {
    const response = await fetch(
      `${apiBase}/questions/${encodeURIComponent(id)}/answer`,
      {
        body: JSON.stringify({ answer }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );

    if (response.status === CONFLICT) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        question?: Question | null;
      } | null;
      return {
        error: body?.error ?? "This question was already resolved.",
        ok: false,
        question: body?.question ?? null,
      };
    }
    if (!response.ok) {
      throw await failureOf(response);
    }
    const { question } = (await response.json()) as { question: Question };
    return { ok: true, question };
  };

  // --- bridges --------------------------------------------------------------

  /**
   * Both halves of the bridging UI in one call: the form, and the connected
   * agents it offers - a channel is bridged through one agent's Slack app.
   */
  const getChannelBridge = (channelId: string) =>
    request<{ bridge: ChannelBridge | null; slackApps: SlackApp[] }>(
      `/channels/${channelId}/bridge`
    );

  const saveChannelBridge = (
    channelId: string,
    input: { externalChannelId: string; slackAppId: string }
  ) =>
    request<{ bridge: ChannelBridge; channelName: string | null }>(
      `/channels/${channelId}/bridge`,
      { json: input, method: "POST" }
    );

  const deleteChannelBridge = (channelId: string) =>
    request<void>(`/channels/${channelId}/bridge`, { method: "DELETE" });

  /** Which external surfaces can reach an agent - the agent rail's bridge card. */
  const listAgentBridges = (agentId: string) =>
    request<{ bridges: ChannelBridge[]; slackApp: SlackApp | null }>(
      `/bridges/bridges?agentId=${encodeURIComponent(agentId)}`
    );

  // --- the Slack connection wizard ------------------------------------------

  /** `slackApp: null` is the wizard's first step: this agent has no app yet. */
  const getAgentSlackApp = (id: string) =>
    request<SlackAppSetup | { slackApp: null }>(`/agents/${id}/slack-app`);

  /**
   * Step one. The draft row exists before any credential does, because the
   * manifest has to name the events URL, and that URL carries the row's id.
   */
  const createAgentSlackApp = (id: string) =>
    request<SlackAppSetup>(`/agents/${id}/slack-app`, { method: "POST" });

  /**
   * Step two. The tokens only ever travel this way - nothing reads them back.
   * A token Slack rejects throws with Slack's own error string as the message.
   */
  const saveAgentSlackTokens = (
    id: string,
    input: { botToken: string; signingSecret: string }
  ) =>
    request<{ slackApp: SlackApp }>(`/agents/${id}/slack-app/tokens`, {
      json: input,
      method: "PUT",
    }).then((data) => data.slackApp);

  /** Disconnecting takes the app's channel bridges with it. */
  const deleteAgentSlackApp = (id: string) =>
    request<void>(`/agents/${id}/slack-app`, { method: "DELETE" });

  return {
    addChannelMember,
    addConnector,
    addMember,
    answerQuestion,
    assignCategoryItem,
    assignConnectorToAgent,
    assignSkillToAgent,
    channelSocketUrl,
    computerFileUrl,
    createAgent,
    createAgentSlackApp,
    createCategory,
    createChannel,
    createRoutine,
    createSkill,
    createSkillVersion,
    createWikiPage,
    deleteAgent,
    deleteAgentSlackApp,
    deleteCategory,
    deleteChannelBridge,
    deleteRoutine,
    deleteSkill,
    deleteWikiPage,
    deleteWorkspace,
    getAgentSlackApp,
    getAgentStatus,
    getBrowserStatus,
    getChannel,
    getChannelBridge,
    getConnector,
    getRoutine,
    getSkill,
    getThread,
    getWikiPage,
    getWikiRevision,
    getWorkspace,
    linkExternalAuthor,
    listAgentActivity,
    listAgentBridges,
    listAgentConnectors,
    listAgentQuestions,
    listAgentSkills,
    listAgents,
    listBrowserScreenshots,
    listCategories,
    listChannels,
    listComputerDir,
    listConnectorAgents,
    listConnectors,
    listExternalAuthors,
    listMembers,
    listMessages,
    listPendingQuestions,
    listRoutineRuns,
    listRoutines,
    listSkillAgents,
    listSkills,
    listWikiPages,
    listWikiRevisions,
    openAgentDm,
    postMessage,
    readComputerFile,
    readSkillFile,
    reauthorizeConnector,
    removeChannelMember,
    removeConnector,
    removeMember,
    renameCategory,
    renameConnector,
    renameWorkspace,
    retrySkillSync,
    rotateAgentMcpToken,
    runRoutine,
    saveAgentSlackTokens,
    saveChannelBridge,
    searchMember,
    setConnectorBearer,
    setConnectorDisabled,
    setConnectorOauthClient,
    setMemberRole,
    skillFileUrl,
    testConnector,
    unassignCategoryItem,
    unassignConnectorFromAgent,
    unassignSkillFromAgent,
    updateAgent,
    updateRoutine,
    updateWikiPage,
    uploadAttachment,
    uploadComputerFile,
    uploadWikiAsset,
    workspaceSlug,
  };
};

/** Everything a component can ask of the workspace it is looking at. */
export type Api = ReturnType<typeof createApi>;
