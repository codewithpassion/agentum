import type { Agent as AgentRow } from "#/modules/agents/schema";
import type { Channel as ChannelRow } from "#/modules/messaging/schema";
import type {
  AttachmentView as AttachmentRow,
  ChannelMemberView as ChannelMemberRow,
  MessageView as MessageRow,
} from "#/modules/messaging/service";

/** The client speaks exactly the server's shapes; these aliases are the contract. */
export type Agent = AgentRow;
export type Channel = ChannelRow;
export type AttachmentView = AttachmentRow;
export type ChannelMemberView = ChannelMemberRow;
export type MessageView = MessageRow;

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
    throw new Error(body?.error ?? `Request failed (${response.status}).`);
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

export const createAgent = (input: AgentInput) =>
  request<{ agent: Agent }>("/agents", { json: input, method: "POST" }).then(
    (data) => data.agent
  );

export const updateAgent = (id: string, input: AgentInput) =>
  request<{ agent: Agent }>(`/agents/${id}`, {
    json: input,
    method: "PATCH",
  }).then((data) => data.agent);

export const deleteAgent = (id: string) =>
  request<void>(`/agents/${id}`, { method: "DELETE" });

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
