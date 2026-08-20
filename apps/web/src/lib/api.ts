import type { ActivityView as ActivityRow } from "#/modules/activity/service";
import type { AgentView } from "#/modules/agents/service";
import type { ChannelBridge as ChannelBridgeRow } from "#/modules/bridges/schema";
import type { SurfaceStatus as SurfaceStatusRow } from "#/modules/bridges/types";
import type {
  BrowserStatus as BrowserStatusRow,
  StoredScreenshot as ScreenshotRow,
} from "#/modules/browser/types";
import type { DirEntry as DirEntryRow } from "#/modules/computer/types";
import type { Channel as ChannelRow } from "#/modules/messaging/schema";
import type {
  AttachmentView as AttachmentRow,
  ChannelMemberView as ChannelMemberRow,
  MessageView as MessageRow,
} from "#/modules/messaging/service";
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
export type DirEntry = DirEntryRow;
export type Screenshot = ScreenshotRow;
export type AttachmentView = AttachmentRow;
export type ChannelMemberView = ChannelMemberRow;
export type MessageView = MessageRow;
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
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    // Server error bodies are `{ error }`; anything else is a transport failure.
    throw new ApiError(
      body?.error ?? `Request failed (${response.status}).`,
      response.status
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
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
