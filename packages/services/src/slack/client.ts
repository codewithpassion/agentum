const SLACK_API = "https://slack.com/api";
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 900;
const MAX_CHANNEL_PAGES = 5;
const CHANNEL_PAGE_SIZE = "200";

/** Slack errors that mean the app or channel setup is wrong. */
const CONFIG_ERRORS = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "is_archived",
  "missing_scope",
  "not_authed",
  "not_in_channel",
  "token_revoked",
]);

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackCallResult<T extends object = Record<never, never>> =
  | ({ kind: "ok" } & T)
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "config"; error: string }
  | { kind: "transient"; error: string }
  | { kind: "rejected"; error: string };

export type SlackDownload =
  | { bytes: Uint8Array<ArrayBuffer>; contentType: string | null; kind: "ok" }
  | { kind: "too_large" }
  | { error: string; kind: "rejected" | "transient" };

export interface SlackClient {
  /** Checks a bot token and tells which workspace and bot user it belongs to. */
  authTest: () => Promise<
    SlackCallResult<{ botId: string | null; teamId: string; userId: string }>
  >;
  /** Gives the app id of a bot. Needs the users:read scope. */
  botInfo: (botId: string) => Promise<SlackCallResult<{ appId: string }>>;
  /** Gives the name of a channel. Needs the channels:read and groups:read scopes. */
  channelName: (
    channelId: string
  ) => Promise<SlackCallResult<{ name: string | null }>>;
  downloadFile: (url: string, maxBytes: number) => Promise<SlackDownload>;
  /** Reads one page of a channel's messages. Needs the channels:history and groups:history scopes. */
  history: (
    request: HistoryWindow
  ) => Promise<
    SlackCallResult<{ messages: HistoryMessage[]; nextCursor: string | null }>
  >;
  /** Lists public and private channels the bot is a member of. Follows up to 5 pages. */
  listChannels: () => Promise<SlackCallResult<{ channels: ChannelEntry[] }>>;
  /** Opens (or finds) the DM between the bot and a user. */
  openDm: (userId: string) => Promise<SlackCallResult<{ channelId: string }>>;
  /** Opens a modal view for a user who clicked a button or ran a shortcut. `trigger_id` expires after about 3 seconds. */
  openView: (request: {
    triggerId: string;
    view: unknown;
  }) => Promise<SlackCallResult>;
  /** Gives the permalink of a message the bot can see. */
  permalink: (
    channel: string,
    ts: string
  ) => Promise<SlackCallResult<{ permalink: string }>>;
  postEphemeral: (request: {
    channel: string;
    text: string;
    threadTs?: string;
    user: string;
  }) => Promise<SlackCallResult>;
  /** Posts a message. `text` is the fallback and is escaped. `blocks` is sent as given, so the caller must escape any text inside it. */
  postMessage: (request: {
    blocks?: unknown[];
    channel: string;
    text: string;
    threadTs?: string;
  }) => Promise<SlackCallResult<{ ts: string }>>;
  /** Reads one page of the replies in a thread, parent included. Needs the channels:history and groups:history scopes. */
  replies: (
    request: HistoryWindow & { ts: string }
  ) => Promise<
    SlackCallResult<{ messages: HistoryMessage[]; nextCursor: string | null }>
  >;
  /** Shows `status` in a thread under the app's name, such as "is thinking…", through assistant.threads.setStatus. An empty string clears it. Needs the assistant:write scope (chat:write also works for now). */
  setStatus: (request: {
    channel: string;
    status: string;
    threadTs: string;
  }) => Promise<SlackCallResult>;
  /** Replaces the text and blocks of a message the bot posted. `text` is escaped; `blocks` is sent as given. */
  updateMessage: (request: {
    blocks?: unknown[];
    channel: string;
    text: string;
    ts: string;
  }) => Promise<SlackCallResult>;
  uploadFile: (request: {
    bytes: Uint8Array<ArrayBuffer>;
    channel: string;
    filename: string;
    threadTs?: string;
  }) => Promise<SlackCallResult<{ fileId: string }>>;
  userEmail: (
    userId: string
  ) => Promise<SlackCallResult<{ email: string | null }>>;
  /** Gives the display name of a user, and the other distinct names Slack knows them by. Needs the users:read scope. */
  userName: (
    userId: string
  ) => Promise<SlackCallResult<{ aliases: string[]; name: string | null }>>;
}

type Body = Record<string, unknown>;

interface Endpoint {
  body?: Body;
  method: "GET" | "POST";
  url: URL;
}

function apiUrl(method: string, query: Record<string, string> = {}): URL {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function asBody(value: unknown): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {};
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "network_error";
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS)
    : DEFAULT_RATE_LIMIT_SECONDS;
}

/**
 * `&`, `<` and `>` are the only characters Slack reads as control syntax, so
 * escaping them leaves no way to write a mention (`<!channel>`, `<@U123>`), a
 * channel link or a masked link (`<https://evil|label>`) in text an agent
 * wrote.
 */
function escapeSlack(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A well-formed user mention (`<@U…>`) or channel link (`<#C…>`): a letter, then 8 or more capitals and digits. */
const PASS_THROUGH = /(<@[UW][A-Z0-9]{8,}>|<#[CG][A-Z0-9]{8,}>)/;

/**
 * Escapes like `escapeSlack`, except a well-formed user mention or channel
 * link, which stays as written. Control syntax is still escaped: `<!channel>`,
 * `<!here>`, `<@U123|label>`, masked links and short or odd ids.
 */
function escapeSlackKeepingMentions(text: string): string {
  return text
    .split(PASS_THROUGH)
    .map((part, index) => (index % 2 === 1 ? part : escapeSlack(part)))
    .join("");
}

function classify<T extends object>(
  body: Body,
  response: Response,
  read: (body: Body) => T | null
): SlackCallResult<T> {
  if (body.ok === true) {
    const value = read(body);
    if (value !== null) {
      return { kind: "ok", ...value };
    }
    return { error: "no_error", kind: "rejected" };
  }
  const error = typeof body.error === "string" ? body.error : "no_error";
  if (error === "ratelimited") {
    return { kind: "rate_limited", retryAfterSeconds: retryAfter(response) };
  }
  if (CONFIG_ERRORS.has(error)) {
    return { error, kind: "config" };
  }
  return { error, kind: "rejected" };
}

interface ChannelEntry {
  id: string;
  isPrivate: boolean;
  name: string;
}

function readChannelPage(
  body: Body
): { channels: ChannelEntry[]; nextCursor: string } | null {
  if (!Array.isArray(body.channels)) {
    return null;
  }
  const channels = body.channels.flatMap((entry) => {
    const { id, is_private: isPrivate, name } = asBody(entry);
    return typeof id === "string" &&
      id !== "" &&
      typeof name === "string" &&
      name !== ""
      ? [{ id, isPrivate: isPrivate === true, name }]
      : [];
  });
  const cursor = asBody(body.response_metadata).next_cursor;
  return {
    channels,
    nextCursor: typeof cursor === "string" ? cursor : "",
  };
}

export interface HistoryMessage {
  botId: string | null;
  text: string;
  threadTs: string | null;
  ts: string;
  user: string | null;
}

interface HistoryWindow {
  channel: string;
  cursor?: string;
  latest?: string;
  limit: number;
  oldest?: string;
}

function historyQuery(request: HistoryWindow): Record<string, string> {
  const query: Record<string, string> = {
    channel: request.channel,
    limit: String(request.limit),
  };
  if (request.cursor !== undefined) {
    query.cursor = request.cursor;
  }
  if (request.latest !== undefined) {
    query.latest = request.latest;
  }
  if (request.oldest !== undefined) {
    query.oldest = request.oldest;
  }
  return query;
}

/** Reads one page of messages in Slack's order. Entries without a ts are skipped. */
function readHistoryPage(
  body: Body
): { messages: HistoryMessage[]; nextCursor: string | null } | null {
  if (!Array.isArray(body.messages)) {
    return null;
  }
  const messages = body.messages.flatMap((entry) => {
    const {
      bot_id: botId,
      text,
      thread_ts: threadTs,
      ts,
      user,
    } = asBody(entry);
    return typeof ts === "string"
      ? [
          {
            botId: typeof botId === "string" ? botId : null,
            text: typeof text === "string" ? text : "",
            threadTs: typeof threadTs === "string" ? threadTs : null,
            ts,
            user: typeof user === "string" ? user : null,
          },
        ]
      : [];
  });
  const cursor = asBody(body.response_metadata).next_cursor;
  return {
    messages,
    nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
  };
}

function isSlackFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return (
    parsed.protocol === "https:" &&
    (host === "files.slack.com" || host.endsWith(".slack-files.com"))
  );
}

/** Reads the body up to maxBytes. The cap is enforced per chunk, before buffering. */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<SlackDownload> {
  const contentType = response.headers.get("content-type");
  const { body } = response;
  if (body === null) {
    return { bytes: new Uint8Array(0), contentType, kind: "ok" };
  }
  let total = 0;
  const cap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new RangeError("slack download over cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    const buffer = await new Response(body.pipeThrough(cap)).arrayBuffer();
    return { bytes: new Uint8Array(buffer), contentType, kind: "ok" };
  } catch (error) {
    if (total > maxBytes) {
      return { kind: "too_large" };
    }
    return { error: errorName(error), kind: "transient" };
  }
}

export const createSlackClient = (deps: {
  fetch: SlackFetch;
  token: string;
}): SlackClient => {
  /** Calls one Slack Web API method. Never throws, and never puts the token in a result. */
  async function callSlack<T extends object>(
    endpoint: Endpoint,
    read: (body: Body) => T | null
  ): Promise<SlackCallResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.token}`,
    };
    let body: string | undefined;
    if (endpoint.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(endpoint.body);
    }
    let response: Response;
    try {
      response = await deps.fetch(endpoint.url.href, {
        body,
        headers,
        method: endpoint.method,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      return { error: errorName(error), kind: "transient" };
    }
    if (response.status === 429) {
      return { kind: "rate_limited", retryAfterSeconds: retryAfter(response) };
    }
    if (response.status >= 500) {
      return { error: `http_${response.status}`, kind: "transient" };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return {
        error: `http_${response.status}_bad_body`,
        kind: "transient",
      };
    }
    return classify(asBody(parsed), response, read);
  }

  /** Reads one page of channels, then the next page while Slack gives a cursor. */
  async function listChannelPages(
    cursor: string,
    pagesLeft: number,
    channels: ChannelEntry[]
  ): Promise<SlackCallResult<{ channels: ChannelEntry[] }>> {
    const query: Record<string, string> = {
      exclude_archived: "true",
      limit: CHANNEL_PAGE_SIZE,
      types: "public_channel,private_channel",
    };
    if (cursor !== "") {
      query.cursor = cursor;
    }
    const result = await callSlack(
      { method: "GET", url: apiUrl("users.conversations", query) },
      readChannelPage
    );
    if (result.kind !== "ok") {
      return result;
    }
    const all = [...channels, ...result.channels];
    if (result.nextCursor === "" || pagesLeft <= 1) {
      return { channels: all, kind: "ok" };
    }
    return listChannelPages(result.nextCursor, pagesLeft - 1, all);
  }

  return {
    authTest() {
      return callSlack({ method: "GET", url: apiUrl("auth.test") }, (body) => {
        const { bot_id: botId, team_id: teamId, user_id: userId } = body;
        if (
          typeof teamId !== "string" ||
          teamId === "" ||
          typeof userId !== "string" ||
          userId === ""
        ) {
          return null;
        }
        return {
          botId: typeof botId === "string" && botId !== "" ? botId : null,
          teamId,
          userId,
        };
      });
    },

    botInfo(botId) {
      return callSlack(
        { method: "GET", url: apiUrl("bots.info", { bot: botId }) },
        (body) => {
          const { app_id: appId } = asBody(body.bot);
          return typeof appId === "string" && appId !== "" ? { appId } : null;
        }
      );
    },

    channelName(channelId) {
      return callSlack(
        {
          method: "GET",
          url: apiUrl("conversations.info", { channel: channelId }),
        },
        (body) => {
          const { name } = asBody(body.channel);
          return {
            name: typeof name === "string" && name !== "" ? name : null,
          };
        }
      );
    },

    async downloadFile(url, maxBytes) {
      if (!isSlackFileUrl(url)) {
        return { error: "bad_host", kind: "rejected" };
      }
      let response: Response;
      try {
        response = await deps.fetch(url, {
          headers: { Authorization: `Bearer ${deps.token}` },
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        return { error: errorName(error), kind: "transient" };
      }
      if (response.status === 429 || response.status >= 500) {
        return { error: `http_${response.status}`, kind: "transient" };
      }
      if (!response.ok) {
        return { error: `http_${response.status}`, kind: "rejected" };
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > maxBytes) {
        return { kind: "too_large" };
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.toLowerCase().startsWith("text/html")) {
        return { error: "html_response", kind: "rejected" };
      }
      return readCapped(response, maxBytes);
    },

    history(request) {
      return callSlack(
        {
          method: "GET",
          url: apiUrl("conversations.history", historyQuery(request)),
        },
        readHistoryPage
      );
    },

    listChannels() {
      return listChannelPages("", MAX_CHANNEL_PAGES, []);
    },

    openDm(userId) {
      return callSlack(
        {
          body: { users: userId },
          method: "POST",
          url: apiUrl("conversations.open"),
        },
        (body) => {
          const { id } = asBody(body.channel);
          return typeof id === "string" && id !== "" ? { channelId: id } : null;
        }
      );
    },

    openView(request) {
      return callSlack(
        {
          body: { trigger_id: request.triggerId, view: request.view },
          method: "POST",
          url: apiUrl("views.open"),
        },
        () => ({})
      );
    },

    permalink(channel, ts) {
      return callSlack(
        {
          method: "GET",
          url: apiUrl("chat.getPermalink", { channel, message_ts: ts }),
        },
        (body) => {
          const { permalink } = body;
          return typeof permalink === "string" && permalink !== ""
            ? { permalink }
            : null;
        }
      );
    },

    postEphemeral(request) {
      return callSlack(
        {
          body: {
            channel: request.channel,
            text: escapeSlack(request.text),
            thread_ts: request.threadTs,
            user: request.user,
          },
          method: "POST",
          url: apiUrl("chat.postEphemeral"),
        },
        () => ({})
      );
    },

    postMessage(request) {
      return callSlack(
        {
          body: {
            blocks: request.blocks,
            channel: request.channel,
            text: escapeSlackKeepingMentions(request.text),
            thread_ts: request.threadTs,
            unfurl_links: false,
            unfurl_media: false,
          },
          method: "POST",
          url: apiUrl("chat.postMessage"),
        },
        (body) => {
          const { ts } = body;
          return typeof ts === "string" ? { ts } : null;
        }
      );
    },

    replies(request) {
      return callSlack(
        {
          method: "GET",
          url: apiUrl("conversations.replies", {
            ...historyQuery(request),
            ts: request.ts,
          }),
        },
        readHistoryPage
      );
    },

    setStatus(request) {
      return callSlack(
        {
          body: {
            channel_id: request.channel,
            status: request.status,
            thread_ts: request.threadTs,
          },
          method: "POST",
          url: apiUrl("assistant.threads.setStatus"),
        },
        () => ({})
      );
    },

    updateMessage(request) {
      return callSlack(
        {
          body: {
            blocks: request.blocks,
            channel: request.channel,
            text: escapeSlack(request.text),
            ts: request.ts,
          },
          method: "POST",
          url: apiUrl("chat.update"),
        },
        () => ({})
      );
    },

    async uploadFile(request) {
      const started = await callSlack(
        {
          method: "GET",
          url: apiUrl("files.getUploadURLExternal", {
            filename: request.filename,
            length: String(request.bytes.byteLength),
          }),
        },
        (body) => {
          const { file_id: fileId, upload_url: uploadUrl } = body;
          return typeof fileId === "string" &&
            fileId !== "" &&
            typeof uploadUrl === "string" &&
            uploadUrl !== ""
            ? { fileId, uploadUrl }
            : null;
        }
      );
      if (started.kind !== "ok") {
        return started;
      }
      const { fileId, uploadUrl } = started;
      if (!isSlackFileUrl(uploadUrl)) {
        return { error: "bad_host", kind: "rejected" };
      }
      let upload: Response;
      try {
        upload = await deps.fetch(uploadUrl, {
          body: request.bytes,
          headers: { "Content-Type": "application/octet-stream" },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        return { error: errorName(error), kind: "transient" };
      }
      if (upload.status === 429 || upload.status >= 500) {
        return { error: `http_${upload.status}`, kind: "transient" };
      }
      if (!upload.ok) {
        return { error: `http_${upload.status}`, kind: "rejected" };
      }
      return callSlack(
        {
          body: {
            channel_id: request.channel,
            files: [{ id: fileId, title: request.filename }],
            thread_ts: request.threadTs,
          },
          method: "POST",
          url: apiUrl("files.completeUploadExternal"),
        },
        () => ({ fileId })
      );
    },

    userEmail(userId) {
      return callSlack(
        { method: "GET", url: apiUrl("users.info", { user: userId }) },
        (body) => {
          const profile = asBody(asBody(body.user).profile);
          const { email } = profile;
          return {
            email: typeof email === "string" && email !== "" ? email : null,
          };
        }
      );
    },

    userName(userId) {
      return callSlack(
        { method: "GET", url: apiUrl("users.info", { user: userId }) },
        (body) => {
          const user = asBody(body.user);
          const profile = asBody(user.profile);
          const names = [
            profile.display_name,
            profile.real_name,
            user.real_name,
            user.name,
          ].filter(
            (candidate): candidate is string =>
              typeof candidate === "string" && candidate !== ""
          );
          return { aliases: [...new Set(names)], name: names[0] ?? null };
        }
      );
    },
  };
};
