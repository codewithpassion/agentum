/**
 * The Slack Web API, narrowed to the calls this connector makes. Everything
 * that talks to Slack goes through this interface, so the rest of the module -
 * and every test - can run against a fake.
 */

const SLACK_API_BASE = "https://slack.com/api";
const TOO_MANY_REQUESTS = 429;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 30;
const MILLISECONDS = 1000;

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackUploadInput {
  channel: string;
  data: ArrayBuffer;
  filename: string;
  threadTs?: string;
}

export interface SlackChannelInfo {
  id: string;
  isMember: boolean;
  name: string;
}

export interface SlackClient {
  /** `null` when Slack refused the call - never throws for an API-level error. */
  conversationsInfo: (channel: string) => Promise<SlackChannelInfo | null>;
  /** Best effort: the bot may already be a member, or the channel private. */
  conversationsJoin: (channel: string) => Promise<boolean>;
  /** Downloads a `url_private` with the bot token. */
  downloadFile: (urlPrivate: string) => Promise<ArrayBuffer | null>;
  postMessage: (input: SlackPostMessageInput) => Promise<{ ts: string } | null>;
  uploadFile: (input: SlackUploadInput) => Promise<boolean>;
  usersInfo: (userId: string) => Promise<{ displayName: string } | null>;
}

interface SlackApiResponse {
  error?: string;
  ok: boolean;
}

export type SlackAuthTest =
  | { botUserId: string | null; ok: true; teamId: string; teamName: string }
  | { error: string; ok: false };

/**
 * `auth.test` is the only call made with a token we do not trust yet, so it is
 * a plain function rather than a client method: the client's helpers turn every
 * failure into `null`, and here Slack's own error string is the answer the
 * wizard shows.
 *
 * The response identifies the installation: `team_id`/`team` name the Slack
 * workspace, and `user_id` is the bot's *user* id - the `<@U…>` a mention of it
 * carries.
 */
export const slackAuthTest = async (
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<SlackAuthTest> => {
  let payload: {
    error?: string;
    ok?: boolean;
    team?: string;
    team_id?: string;
    user_id?: string;
  };
  try {
    const response = await fetchImpl(`${SLACK_API_BASE}/auth.test`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Slack is unreachable.",
      ok: false,
    };
  }

  if (!payload.ok) {
    return { error: payload.error || "invalid_auth", ok: false };
  }
  return {
    botUserId: payload.user_id ?? null,
    ok: true,
    teamId: payload.team_id ?? "",
    teamName: payload.team ?? "",
  };
};

export interface SlackClientOptions {
  fetchImpl?: typeof fetch;
  /** Injected so the 429 retry is instant in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const retryDelayMs = (response: Response): number => {
  const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  const seconds = Number.isFinite(header)
    ? Math.min(header, MAX_RETRY_AFTER_SECONDS)
    : DEFAULT_RETRY_AFTER_SECONDS;
  return seconds * MILLISECONDS;
};

export const createSlackClient = (
  token: string,
  options: SlackClientOptions = {}
): SlackClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  /**
   * One retry on 429, honouring `Retry-After`. Slack's own guidance; a second
   * failure is reported as `null` and the caller carries on without Slack.
   */
  const send = async <T extends SlackApiResponse>(
    request: () => Promise<Response>
  ): Promise<T | null> => {
    let response = await request();
    if (response.status === TOO_MANY_REQUESTS) {
      await sleep(retryDelayMs(response));
      response = await request();
    }
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as T;
    return payload.ok ? payload : null;
  };

  /** Write methods: documented as POST, JSON accepted. */
  const post = <T extends SlackApiResponse>(
    method: string,
    body: Record<string, unknown>
  ): Promise<T | null> =>
    send<T>(() =>
      fetchImpl(`${SLACK_API_BASE}/${method}`, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
      })
    );

  /** Read methods: documented as GET, arguments in the query string. */
  const get = <T extends SlackApiResponse>(
    method: string,
    params: Record<string, string>
  ): Promise<T | null> =>
    send<T>(() =>
      fetchImpl(
        `${SLACK_API_BASE}/${method}?${new URLSearchParams(params).toString()}`,
        { headers: { authorization: `Bearer ${token}` }, method: "GET" }
      )
    );

  const uploadUrlFor = async (filename: string, length: number) => {
    const payload = await get<
      SlackApiResponse & { file_id?: string; upload_url?: string }
    >("files.getUploadURLExternal", { filename, length: String(length) });
    return payload?.file_id && payload.upload_url
      ? { fileId: payload.file_id, uploadUrl: payload.upload_url }
      : null;
  };

  return {
    async conversationsInfo(channel) {
      const payload = await get<
        SlackApiResponse & {
          channel?: { id: string; is_member?: boolean; name?: string };
        }
      >("conversations.info", { channel });
      if (!payload?.channel) {
        return null;
      }
      return {
        id: payload.channel.id,
        isMember: payload.channel.is_member ?? false,
        name: payload.channel.name ?? payload.channel.id,
      };
    },

    async conversationsJoin(channel) {
      const payload = await post<SlackApiResponse>("conversations.join", {
        channel,
      });
      return payload !== null;
    },

    async downloadFile(urlPrivate) {
      const response = await fetchImpl(urlPrivate, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        return null;
      }
      return await response.arrayBuffer();
    },

    async postMessage(input) {
      const payload = await post<SlackApiResponse & { ts?: string }>(
        "chat.postMessage",
        {
          channel: input.channel,
          text: input.text,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        }
      );
      return payload?.ts ? { ts: payload.ts } : null;
    },

    /**
     * `files.upload` is retired; the surviving flow is get-url → PUT bytes →
     * complete, which is also what associates the file with the thread.
     */
    async uploadFile(input) {
      const target = await uploadUrlFor(input.filename, input.data.byteLength);
      if (!target) {
        return false;
      }

      const uploaded = await fetchImpl(target.uploadUrl, {
        body: input.data,
        method: "POST",
      });
      if (!uploaded.ok) {
        return false;
      }

      const payload = await post<SlackApiResponse>(
        "files.completeUploadExternal",
        {
          channel_id: input.channel,
          files: [{ id: target.fileId, title: input.filename }],
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        }
      );
      return payload !== null;
    },

    async usersInfo(userId) {
      const payload = await get<
        SlackApiResponse & {
          user?: {
            name?: string;
            profile?: { display_name?: string; real_name?: string };
          };
        }
      >("users.info", { user: userId });
      const user = payload?.user;
      if (!user) {
        return null;
      }
      const displayName =
        user.profile?.display_name || user.profile?.real_name || user.name;
      return displayName ? { displayName } : null;
    },
  };
};
