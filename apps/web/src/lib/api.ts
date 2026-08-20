import type { ActivityView as ActivityRow } from "#/modules/activity/service";
import type { AgentView } from "#/modules/agents/service";
import type { ChannelBridge as ChannelBridgeRow } from "#/modules/bridges/schema";
import type { SurfaceStatus as SurfaceStatusRow } from "#/modules/bridges/types";
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
  SkillFileView as SkillFileRow,
  SkillView as SkillRow,
  SkillVersionView as SkillVersionRow,
} from "#/modules/skills/service";
import type {
  WikiPageSummary as WikiPageSummaryRow,
  WikiPageView,
  WikiRevisionView,
} from "#/modules/wiki/service";

/** The client speaks exactly the server's shapes; these aliases are the contract. */
export type Agent = AgentView;
export type ActivityView = ActivityRow;
export type BrowserStatus = BrowserStatusRow;
export type Channel = ChannelRow;
export type Connector = ConnectorRow;
export type ConnectorStatus = Connector["status"];
/** What the add-connector dialog must do next; see the ladder in plan 4b. */
export type StartOutcome = StartOutcomeRow;
export type DirEntry = DirEntryRow;
export type Screenshot = ScreenshotRow;
export type AttachmentView = AttachmentRow;
export type ChannelMemberView = ChannelMemberRow;
export type MessageView = MessageRow;
export type Skill = SkillRow;
export type SkillSyncStatus = Skill["syncStatus"];
export type SkillVersion = SkillVersionRow;
export type SkillFile = SkillFileRow;
export type WikiPage = WikiPageView;
export type WikiPageSummary = WikiPageSummaryRow;
export type WikiRevision = WikiRevisionView;

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

const request = async <T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> => {
  const { json, ...rest } = init ?? {};
  const response = await fetch(`/api${path}`, {
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

/** For the endpoints that answer with a file's bytes rather than JSON. */
const requestText = async (path: string): Promise<string> => {
  const response = await fetch(`/api${path}`);
  if (!response.ok) {
    throw await failureOf(response);
  }
  return await response.text();
};

// --- agents -----------------------------------------------------------------

export interface AgentInput {
  instructions: string;
  name: string;
  soul: string;
}

export const listAgents = () =>
  request<{ agents: Agent[] }>("/agents").then((data) => data.agents);

/** The MCP URL is returned once, when the token behind it is issued. */
export interface IssuedAgent {
  agent: Agent;
  mcpUrl: string;
}

export const createAgent = (input: AgentInput) =>
  request<IssuedAgent>("/agents", { json: input, method: "POST" });

export const updateAgent = (id: string, input: AgentInput) =>
  request<{ agent: Agent }>(`/agents/${id}`, {
    json: input,
    method: "PATCH",
  }).then((data) => data.agent);

/** Invalidates the agent's current MCP URL and returns its replacement. */
export const rotateAgentMcpToken = (id: string) =>
  request<IssuedAgent>(`/agents/${id}`, {
    json: { rotateMcpToken: true },
    method: "PATCH",
  });

export const deleteAgent = (id: string) =>
  request<void>(`/agents/${id}`, { method: "DELETE" });

/** What the router and the Anthropic registration currently say about an agent. */
export interface AgentStatusView {
  agentId: string;
  sessionId: string | null;
  status: Agent["status"];
  syncError: string | null;
  syncStatus: Agent["syncStatus"];
}

export const getAgentStatus = (id: string) =>
  request<{ status: AgentStatusView }>(`/agents/${id}/status`).then(
    (data) => data.status
  );

// --- the agent's screen: activity, computer, browser ------------------------

export interface ActivityPage {
  entries: ActivityView[];
  nextCursor: string | null;
}

/** Newest first; `before` is the `nextCursor` of the page before it. */
export const listAgentActivity = (
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

export const listComputerDir = (id: string, path: string) =>
  request<{ entries: DirEntry[] }>(
    `/agents/${id}/computer/ls?path=${encodeURIComponent(path)}`
  ).then((data) => data.entries);

export interface ComputerFile {
  content: string;
  path: string;
  size: number;
}

/** The raw endpoint, for the "this file will not preview" download link. */
export const computerFileUrl = (id: string, path: string): string =>
  `/api/agents/${id}/computer/file?path=${encodeURIComponent(path)}`;

export const readComputerFile = (id: string, path: string) =>
  request<ComputerFile>(
    `/agents/${id}/computer/file?path=${encodeURIComponent(path)}`
  );

/** The user putting a file onto the agent's computer, from the Files tab. */
export const uploadComputerFile = async (
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

export interface ScreenshotPage {
  nextCursor: string | null;
  screenshots: Screenshot[];
}

export const listBrowserScreenshots = (id: string, limit: number) =>
  request<ScreenshotPage>(`/agents/${id}/browser/screenshots?limit=${limit}`);

export const getBrowserStatus = (id: string) =>
  request<BrowserStatus>(`/agents/${id}/browser/status`);

// --- channels ---------------------------------------------------------------

export const listChannels = () =>
  request<{ channels: Channel[] }>("/channels").then((data) => data.channels);

export const createChannel = (input: { agentIds: string[]; name: string }) =>
  request<{ channel: Channel }>("/channels", {
    json: input,
    method: "POST",
  }).then((data) => data.channel);

/** DMs are one-per-agent; the server reuses the existing channel if there is one. */
export const openAgentDm = (agentId: string) =>
  request<{ channel: Channel }>("/channels", {
    json: { agentId, kind: "dm" },
    method: "POST",
  }).then((data) => data.channel);

export const getChannel = (id: string) =>
  request<{ channel: Channel; members: ChannelMemberView[] }>(
    `/channels/${id}`
  );

export const listMessages = (id: string, cursor?: string) =>
  request<{ messages: MessageView[]; nextCursor: string | null }>(
    `/channels/${id}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
  );

export const postMessage = (
  channelId: string,
  input: { attachmentIds?: string[]; body: string; threadParentId?: string }
) =>
  request<{ message: MessageView }>(`/channels/${channelId}/messages`, {
    json: input,
    method: "POST",
  }).then((data) => data.message);

export const addChannelMember = (
  channelId: string,
  member: { memberId: string; memberType: "agent" | "user" }
) =>
  request<{ members: ChannelMemberView[] }>(`/channels/${channelId}/members`, {
    json: member,
    method: "POST",
  }).then((data) => data.members);

export const removeChannelMember = (
  channelId: string,
  memberType: "agent" | "user",
  memberId: string
) =>
  request<{ members: ChannelMemberView[] }>(
    `/channels/${channelId}/members/${memberType}/${encodeURIComponent(memberId)}`,
    { method: "DELETE" }
  ).then((data) => data.members);

// --- categories -------------------------------------------------------------

export interface CategoryItemRef {
  itemId: string;
  itemType: "agent" | "channel";
}

export interface CategoryView {
  id: string;
  items: CategoryItemRef[];
  name: string;
}

export const listCategories = () =>
  request<{ categories: CategoryView[] }>("/categories").then(
    (data) => data.categories
  );

export const createCategory = (name: string) =>
  request<{ category: CategoryView }>("/categories", {
    json: { name },
    method: "POST",
  }).then((data) => data.category);

export const renameCategory = (id: string, name: string) =>
  request<{ category: CategoryView }>(`/categories/${id}`, {
    json: { name },
    method: "PATCH",
  }).then((data) => data.category);

export const deleteCategory = (id: string) =>
  request<void>(`/categories/${id}`, { method: "DELETE" });

/** An item lives in at most one category, so assigning moves it. */
export const assignCategoryItem = (categoryId: string, item: CategoryItemRef) =>
  request<void>(`/categories/${categoryId}/items`, {
    json: item,
    method: "PUT",
  });

export const unassignCategoryItem = (
  categoryId: string,
  item: CategoryItemRef
) =>
  request<void>(
    `/categories/${categoryId}/items/${item.itemType}/${encodeURIComponent(item.itemId)}`,
    { method: "DELETE" }
  );

// --- threads & attachments --------------------------------------------------

export const getThread = (messageId: string) =>
  request<{ parent: MessageView; replies: MessageView[] }>(
    `/messages/${messageId}/thread`
  );

export const uploadAttachment = async (file: File): Promise<AttachmentView> => {
  const form = new FormData();
  form.append("file", file);
  const data = await request<{ attachment: AttachmentView }>("/attachments", {
    body: form,
    method: "POST",
  });
  return data.attachment;
};

// --- wiki -------------------------------------------------------------------

export interface WikiAssetView {
  filename: string;
  id: string;
  mime: string;
  size: number;
  url: string;
}

export const listWikiPages = () =>
  request<{ pages: WikiPageSummary[] }>("/wiki").then((data) => data.pages);

export const getWikiPage = (slug: string) =>
  request<{ page: WikiPage }>(`/wiki/${encodeURIComponent(slug)}`).then(
    (data) => data.page
  );

export const createWikiPage = (input: { body: string; title: string }) =>
  request<{ page: WikiPage }>("/wiki", { json: input, method: "POST" }).then(
    (data) => data.page
  );

export const updateWikiPage = (
  slug: string,
  input: { body?: string; title?: string }
) =>
  request<{ page: WikiPage }>(`/wiki/${encodeURIComponent(slug)}`, {
    json: input,
    method: "PATCH",
  }).then((data) => data.page);

export const deleteWikiPage = (slug: string) =>
  request<void>(`/wiki/${encodeURIComponent(slug)}`, { method: "DELETE" });

export const listWikiRevisions = (slug: string) =>
  request<{ revisions: WikiRevision[] }>(
    `/wiki/${encodeURIComponent(slug)}/revisions`
  ).then((data) => data.revisions);

export const getWikiRevision = (slug: string, revisionId: string) =>
  request<{ revision: WikiRevision }>(
    `/wiki/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}`
  ).then((data) => data.revision);

export const uploadWikiAsset = async (
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

// --- connectors -------------------------------------------------------------

/** Just enough of an agent to render a chip or a checkbox row. */
export interface ConnectorAgentRef {
  avatar: string;
  id: string;
  name: string;
}

export const listConnectors = () =>
  request<{ connectors: Connector[] }>("/connectors").then(
    (data) => data.connectors
  );

/** The agent rail's chips and the settings picker's ticked boxes. */
export const listAgentConnectors = (agentId: string) =>
  request<{ connectors: Connector[] }>(
    `/connectors?agentId=${encodeURIComponent(agentId)}`
  ).then((data) => data.connectors);

export const getConnector = (id: string) =>
  request<{ agents: ConnectorAgentRef[]; connector: Connector }>(
    `/connectors/${id}`
  );

/**
 * The pasted URL is probed server-side, so the outcome - not the connector -
 * is what the dialog acts on. The row exists either way, which is what makes an
 * abandoned OAuth attempt resumable from the connector's detail view.
 */
export const addConnector = (input: { name?: string; url: string }) =>
  request<{ connector: Connector; outcome: StartOutcome }>("/connectors", {
    json: input,
    method: "POST",
  });

export const renameConnector = (id: string, name: string) =>
  request<{ connector: Connector }>(`/connectors/${id}`, {
    json: { name },
    method: "PATCH",
  }).then((data) => data.connector);

export const setConnectorDisabled = (id: string, disabled: boolean) =>
  request<{ connector: Connector }>(`/connectors/${id}`, {
    json: { disabled },
    method: "PATCH",
  }).then((data) => data.connector);

/** Archives the vault credential too; `vaultError` reports a partial failure. */
export const removeConnector = (id: string) =>
  request<{ removed: boolean; vaultError: string | null }>(
    `/connectors/${id}`,
    { method: "DELETE" }
  );

/** Rung 3's manual branch: the server has no dynamic client registration. */
export const setConnectorOauthClient = (
  id: string,
  input: { clientId: string; clientSecret?: string | null }
) =>
  request<{ outcome: StartOutcome }>(`/connectors/${id}/oauth/client`, {
    json: input,
    method: "POST",
  }).then((data) => data.outcome);

export const reauthorizeConnector = (id: string) =>
  request<{ outcome: StartOutcome }>(`/connectors/${id}/reauthorize`, {
    method: "POST",
  }).then((data) => data.outcome);

/** Rung 6: no usable OAuth, so a pasted token becomes a static credential. */
export const setConnectorBearer = (id: string, token: string) =>
  request<{ connector: Connector }>(`/connectors/${id}/bearer`, {
    json: { token },
    method: "POST",
  }).then((data) => data.connector);

export interface ConnectorTestResult {
  message: string | null;
  ok: boolean;
  tools: { description: string | null; name: string }[];
}

/** Re-probes the server now and refreshes the cached tool list with it. */
export const testConnector = (id: string) =>
  request<{ connector: Connector; result: ConnectorTestResult }>(
    `/connectors/${id}/test`,
    { method: "POST" }
  );

export const listConnectorAgents = (id: string) =>
  request<{ agents: ConnectorAgentRef[] }>(`/connectors/${id}/agents`).then(
    (data) => data.agents
  );

/** Takes effect on the agent's *next* session - `vault_ids` is create-only. */
export const assignConnectorToAgent = (id: string, agentId: string) =>
  request<{ appliesToNextSession: boolean; assigned: boolean }>(
    `/connectors/${id}/agents`,
    { json: { agentId }, method: "POST" }
  );

export const unassignConnectorFromAgent = (id: string, agentId: string) =>
  request<void>(`/connectors/${id}/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });

// --- skills -----------------------------------------------------------------

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

export const listSkills = () =>
  request<{ skills: Skill[] }>("/skills").then((data) => data.skills);

/** The rail's chips and the settings picker's ticked boxes. */
export const listAgentSkills = (agentId: string) =>
  request<{ skills: AssignedSkill[] }>(
    `/skills?agentId=${encodeURIComponent(agentId)}`
  ).then((data) => data.skills);

export const getSkill = (slug: string, version?: number) =>
  request<SkillDetail>(
    `/skills/${encodeURIComponent(slug)}${version === undefined ? "" : `?version=${version}`}`
  );

/** The raw endpoint, for a file's download link. */
export const skillFileUrl = (
  slug: string,
  version: number,
  path: string
): string =>
  `/api/skills/${encodeURIComponent(slug)}/versions/${version}/file?path=${encodeURIComponent(path)}`;

export const readSkillFile = (slug: string, version: number, path: string) =>
  requestText(
    `/skills/${encodeURIComponent(slug)}/versions/${version}/file?path=${encodeURIComponent(path)}`
  );

export interface PublishedSkill {
  skill: Skill;
  version: SkillVersion;
}

export const createSkill = (input: {
  changelog?: string;
  files: SkillFileInput[];
  slug: string;
}) => request<PublishedSkill>("/skills", { json: input, method: "POST" });

/** A full file set plus the "why" - never a patch of the version before it. */
export const createSkillVersion = (
  slug: string,
  input: { changelog: string; files: SkillFileInput[] }
) =>
  request<PublishedSkill>(`/skills/${encodeURIComponent(slug)}/versions`, {
    json: input,
    method: "POST",
  });

/** Pushes the local versions at Anthropic again after a failed publish. */
export const retrySkillSync = (slug: string) =>
  request<{ skill: Skill }>(`/skills/${encodeURIComponent(slug)}/retry-sync`, {
    method: "POST",
  }).then((data) => data.skill);

/** Unassigns it from every agent, then deletes both mirrors. */
export const deleteSkill = (slug: string) =>
  request<{ anthropicError: string | null; removed: boolean }>(
    `/skills/${encodeURIComponent(slug)}`,
    { method: "DELETE" }
  );

export const listSkillAgents = (slug: string) =>
  request<{ agents: SkillAgentRef[] }>(
    `/skills/${encodeURIComponent(slug)}/agents`
  ).then((data) => data.agents);

/** `pinnedVersion` null tracks latest, which is how a fix propagates (plan 5d). */
export const assignSkillToAgent = (
  slug: string,
  agentId: string,
  pinnedVersion: number | null
) =>
  request<{ assigned: boolean; outcome: string }>(
    `/skills/${encodeURIComponent(slug)}/agents`,
    { json: { agentId, pinnedVersion }, method: "POST" }
  );

export const unassignSkillFromAgent = (slug: string, agentId: string) =>
  request<void>(
    `/skills/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" }
  );

// --- bridges ----------------------------------------------------------------

export type ChannelBridge = ChannelBridgeRow;
export type SurfaceStatus = SurfaceStatusRow;

/** Both halves of the bridging UI in one call: the form and the "not configured" state. */
export const getChannelBridge = (channelId: string) =>
  request<{ bridge: ChannelBridge | null; connector: SurfaceStatus }>(
    `/channels/${channelId}/bridge`
  );

export const saveChannelBridge = (
  channelId: string,
  input: { agentId: string | null; externalChannelId: string }
) =>
  request<{ bridge: ChannelBridge; channelName: string | null }>(
    `/channels/${channelId}/bridge`,
    { json: input, method: "POST" }
  );

export const deleteChannelBridge = (channelId: string) =>
  request<void>(`/channels/${channelId}/bridge`, { method: "DELETE" });

/** Which external surfaces can reach an agent - the agent rail's bridge card. */
export const listAgentBridges = (agentId: string) =>
  request<{ bridges: ChannelBridge[]; connector: SurfaceStatus }>(
    `/bridges/bridges?agentId=${encodeURIComponent(agentId)}`
  );
