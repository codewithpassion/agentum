import { expect, test } from "bun:test";
import { parseEvent } from "./event-parse.ts";

const CONTEXT = { api_app_id: "A123", event_time: 1_355_517_523 };

function callback(event: Record<string, unknown>): unknown {
  return {
    ...CONTEXT,
    event,
    event_id: "Ev0PV52K21",
    team_id: "T123ABC456",
    type: "event_callback",
  };
}

test("the url_verification challenge is read back out", () => {
  expect(
    parseEvent({
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
      token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
      type: "url_verification",
    })
  ).toEqual({
    challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    kind: "url_verification",
  });
});

test("a direct message carries the text, the channel, the sender and the app", () => {
  expect(
    parseEvent(
      callback({
        channel: "D024BE91L",
        channel_type: "im",
        event_ts: "1355517523.000005",
        text: "Hello hello can you hear me?",
        ts: "1355517523.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "D024BE91L",
    eventId: "Ev0PV52K21",
    files: [],
    kind: "message",
    teamId: "T123ABC456",
    text: "Hello hello can you hear me?",
    threadTs: undefined,
    trigger: "dm",
    ts: "1355517523.000005",
    userId: "U2147483697",
  });
});

test("a file_share DM carries its two files, mapped to url", () => {
  expect(
    parseEvent(
      callback({
        channel: "D024BE91L",
        channel_type: "im",
        files: [
          {
            id: "F1",
            mimetype: "text/plain",
            mode: "hosted",
            name: "notes.txt",
            size: 42,
            url_private: "https://files.slack.com/F1",
            url_private_download: "https://files.slack.com/F1/download",
          },
          {
            id: "F2",
            mimetype: "image/png",
            mode: "hosted",
            name: "shot.png",
            size: 2048,
            url_private_download: "https://files.slack.com/F2/download",
          },
        ],
        subtype: "file_share",
        text: "status of ENG-12",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "D024BE91L",
    eventId: "Ev0PV52K21",
    files: [
      {
        id: "F1",
        mimetype: "text/plain",
        name: "notes.txt",
        size: 42,
        url: "https://files.slack.com/F1/download",
      },
      {
        id: "F2",
        mimetype: "image/png",
        name: "shot.png",
        size: 2048,
        url: "https://files.slack.com/F2/download",
      },
    ],
    kind: "message",
    teamId: "T123ABC456",
    text: "status of ENG-12",
    threadTs: undefined,
    trigger: "dm",
    ts: "1355517524.000005",
    userId: "U2147483697",
  });
});

test("a tombstone file, or one with no download URL, is skipped", () => {
  const event = parseEvent(
    callback({
      channel: "D024BE91L",
      channel_type: "im",
      files: [
        { id: "F1", mode: "tombstone", name: "gone.txt" },
        { id: "F2", mimetype: "text/plain", name: "no-url.txt" },
        {
          id: "F3",
          mimetype: "text/plain",
          name: "kept.txt",
          size: 7,
          url_private_download: "https://files.slack.com/F3/download",
        },
      ],
      subtype: "file_share",
      text: "read these",
      ts: "1355517524.000005",
      type: "message",
      user: "U2147483697",
    })
  );
  expect(event).toMatchObject({
    files: [
      {
        id: "F3",
        mimetype: "text/plain",
        name: "kept.txt",
        size: 7,
        url: "https://files.slack.com/F3/download",
      },
    ],
    kind: "message",
  });
});

test("a file with missing name, type or size gets the defaults", () => {
  expect(
    parseEvent(
      callback({
        channel: "D024BE91L",
        channel_type: "im",
        files: [
          { id: "F1", url_private_download: "https://files.slack.com/F1" },
        ],
        subtype: "file_share",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({
    files: [
      {
        id: "F1",
        mimetype: "application/octet-stream",
        name: "file",
        size: 0,
        url: "https://files.slack.com/F1",
      },
    ],
  });
});

test("a message in a channel is read as a channel message", () => {
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        channel_type: "channel",
        text: "approve",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "C024BE91L",
    eventId: "Ev0PV52K21",
    files: [],
    kind: "message",
    teamId: "T123ABC456",
    text: "approve",
    threadTs: undefined,
    trigger: "channel",
    ts: "1355517524.000005",
    userId: "U2147483697",
  });
});

test("a message in a private channel, or with no channel_type, is a channel message", () => {
  expect(
    parseEvent(
      callback({
        channel: "G024BE91L",
        channel_type: "group",
        text: "approve",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({
    channelId: "G024BE91L",
    kind: "message",
    trigger: "channel",
  });
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        text: "approve",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({
    channelId: "C024BE91L",
    kind: "message",
    trigger: "channel",
  });
});

test("a reply in a thread in a channel is answered with the thread it is in", () => {
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        channel_type: "channel",
        text: "approve",
        thread_ts: "1355517000.000001",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "C024BE91L",
    eventId: "Ev0PV52K21",
    files: [],
    kind: "message",
    teamId: "T123ABC456",
    text: "approve",
    threadTs: "1355517000.000001",
    trigger: "thread",
    ts: "1355517524.000005",
    userId: "U2147483697",
  });
});

test("a reply in a thread in a private channel is answered too", () => {
  expect(
    parseEvent(
      callback({
        channel: "G024BE91L",
        channel_type: "group",
        text: "approve",
        thread_ts: "1355517000.000001",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({
    channelId: "G024BE91L",
    threadTs: "1355517000.000001",
    trigger: "thread",
  });
});

test("a thread's parent in a channel is a channel message, not a reply", () => {
  // A thread's parent carries thread_ts equal to its own ts, so it is not a
  // reply.
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        channel_type: "channel",
        text: "approve",
        thread_ts: "1355517524.000005",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({
    kind: "message",
    threadTs: "1355517524.000005",
    trigger: "channel",
  });
});

test("a bot's reply in a thread is ignored, not answered", () => {
  expect(
    parseEvent(
      callback({
        bot_id: "B123ABC456",
        channel: "C024BE91L",
        channel_type: "channel",
        text: "Filed *ENG-13*.",
        thread_ts: "1355517000.000001",
        ts: "1355517524.000005",
        type: "message",
      })
    )
  ).toEqual({ kind: "ignored", reason: "bot_message" });
});

test("an edit of a thread reply becomes message_edited with the original ts", () => {
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        channel_type: "channel",
        message: {
          text: "approve now",
          thread_ts: "1355517000.000001",
          ts: "1355517524.000005",
          user: "U2147483697",
        },
        previous_message: {
          text: "approve",
          thread_ts: "1355517000.000001",
          ts: "1355517524.000005",
          user: "U2147483697",
        },
        subtype: "message_changed",
        ts: "1355517600.000100",
        type: "message",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "C024BE91L",
    kind: "message_edited",
    teamId: "T123ABC456",
    text: "approve now",
    ts: "1355517524.000005",
  });
});

test("the app's own DM, sent with bot_id, is ignored so it cannot answer itself", () => {
  expect(
    parseEvent(
      callback({
        bot_id: "B123ABC456",
        channel: "D024BE91L",
        channel_type: "im",
        text: "Approved by Dominik.",
        ts: "1355517524.000005",
        type: "message",
      })
    )
  ).toEqual({ kind: "ignored", reason: "bot_message" });
});

test("an echo whose app_id is this app's api_app_id is ignored", () => {
  // The shape of a chat.postMessage echo, less the bot_id the docs do not
  // promise: the bot user as sender, the app's own id and profile.
  const echo = {
    channel: "D024BE91L",
    channel_type: "im",
    text: "Filed *ENG-13* the cache is cold.",
    ts: "1355517524.000005",
    type: "message",
    user: "U0BOTUSER",
  };
  expect(parseEvent(callback({ ...echo, app_id: "A123" }))).toEqual({
    kind: "ignored",
    reason: "bot_message",
  });
  expect(
    parseEvent(
      callback({
        ...echo,
        app_id: "A123",
        bot_profile: { app_id: "A123", id: "B123ABC456", name: "Ariadne" },
      })
    )
  ).toEqual({ kind: "ignored", reason: "bot_message" });
  // A null bot_profile is not a bot: Slack sends null bot fields on people's
  // messages.
  expect(parseEvent(callback({ ...echo, bot_profile: null })).kind).toBe(
    "message"
  );
  // Another app's id alone is not this app's echo.
  expect(parseEvent(callback({ ...echo, app_id: "A999" })).kind).toBe(
    "message"
  );
});

test("Slack's own file_share sample, with null bot fields, is answered", () => {
  expect(
    parseEvent(
      callback({
        bot_id: null,
        channel: "D024BE91L",
        channel_type: "im",
        files: [{ id: "F1" }],
        subtype: "file_share",
        text: "status of ENG-12",
        ts: "1355517524.000005",
        type: "message",
        user: "U2147483697",
      })
    )
  ).toMatchObject({ kind: "message", text: "status of ENG-12", trigger: "dm" });
});

test("a deleted message becomes message_deleted with the deleted ts", () => {
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        channel_type: "channel",
        deleted_ts: "1355517524.000005",
        hidden: true,
        previous_message: {
          text: "approve",
          ts: "1355517524.000005",
          user: "U2147483697",
        },
        subtype: "message_deleted",
        ts: "1355517600.000200",
        type: "message",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "C024BE91L",
    kind: "message_deleted",
    teamId: "T123ABC456",
    ts: "1355517524.000005",
  });
});

test("an edit of a bot's message, this app's own included, is ignored as bot_message", () => {
  const edit = (message: Record<string, unknown>) =>
    callback({
      channel: "D024BE91L",
      channel_type: "im",
      message: { ts: "1355517524.000005", ...message },
      subtype: "message_changed",
      ts: "1355517600.000100",
      type: "message",
    });
  expect(
    parseEvent(edit({ bot_id: "B123ABC456", text: "Filed *ENG-13*." }))
  ).toEqual({
    kind: "ignored",
    reason: "bot_message",
  });
  expect(parseEvent(edit({ app_id: "A123", text: "Filed *ENG-13*." }))).toEqual(
    {
      kind: "ignored",
      reason: "bot_message",
    }
  );
});

test("an edit with no ts in the edited message, or a delete with no deleted_ts, is malformed", () => {
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        message: { text: "approve now", user: "U2147483697" },
        subtype: "message_changed",
        ts: "1355517600.000100",
        type: "message",
      })
    ).kind
  ).toBe("malformed");
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        subtype: "message_changed",
        ts: "1355517600.000100",
        type: "message",
      })
    ).kind
  ).toBe("malformed");
  expect(
    parseEvent(
      callback({
        channel: "C024BE91L",
        subtype: "message_deleted",
        ts: "1355517600.000200",
        type: "message",
      })
    ).kind
  ).toBe("malformed");
});

test("a mention in a thread carries the thread it was written in", () => {
  expect(
    parseEvent(
      callback({
        channel: "C123ABC456",
        text: "<@U0LAN0Z89> approve",
        thread_ts: "1515449000.000001",
        ts: "1515449522.000016",
        type: "app_mention",
        user: "U061F7AUR",
      })
    )
  ).toEqual({
    apiAppId: "A123",
    channelId: "C123ABC456",
    eventId: "Ev0PV52K21",
    files: [],
    kind: "message",
    teamId: "T123ABC456",
    text: "<@U0LAN0Z89> approve",
    threadTs: "1515449000.000001",
    trigger: "mention",
    ts: "1515449522.000016",
    userId: "U061F7AUR",
  });
});

test("a mention outside a thread has no threadTs", () => {
  // Slack's own app_mention sample, which has no channel_type.
  expect(
    parseEvent(
      callback({
        channel: "C123ABC456",
        event_ts: "1515449522000016",
        text: "<@U0LAN0Z89> is it everything a river should be?",
        ts: "1515449522.000016",
        type: "app_mention",
        user: "U061F7AUR",
      })
    )
  ).toMatchObject({
    kind: "message",
    text: "<@U0LAN0Z89> is it everything a river should be?",
    threadTs: undefined,
    trigger: "mention",
    userId: "U061F7AUR",
  });
});

test("a mention from a bot, this app, an edit, or no sender is ignored", () => {
  const mention = {
    channel: "C123ABC456",
    text: "<@U0LAN0Z89> help",
    ts: "1515449522.000016",
    type: "app_mention",
    user: "U061F7AUR",
  };
  expect(parseEvent(callback({ ...mention, bot_id: "B1" }))).toEqual({
    kind: "ignored",
    reason: "bot_message",
  });
  expect(parseEvent(callback({ ...mention, app_id: "A123" }))).toEqual({
    kind: "ignored",
    reason: "bot_message",
  });
  expect(
    parseEvent(callback({ ...mention, subtype: "message_changed" }))
  ).toEqual({ kind: "ignored", reason: "message_subtype" });
  expect(parseEvent(callback({ ...mention, user: undefined }))).toEqual({
    kind: "ignored",
    reason: "no_sender",
  });
  // Null bot fields are a person's mention.
  expect(
    parseEvent(
      callback({ ...mention, app_id: null, bot_id: null, bot_profile: null })
    ).kind
  ).toBe("message");
});

test("a thread reply also sent to the channel is still answered", () => {
  expect(
    parseEvent(
      callback({
        channel: "C123ABC456",
        subtype: "thread_broadcast",
        text: "<@U0LAN0Z89> approve",
        thread_ts: "1515449000.000001",
        ts: "1515449522.000016",
        type: "app_mention",
        user: "U061F7AUR",
      })
    )
  ).toMatchObject({
    kind: "message",
    threadTs: "1515449000.000001",
    trigger: "mention",
  });
});

test("an event the app did not ask for is ignored, not an error", () => {
  expect(
    parseEvent(callback({ item: {}, type: "reaction_added", user: "U1" }))
  ).toEqual({ kind: "ignored", reason: "unsupported_event" });
  expect(
    parseEvent(
      callback({ channel: "D1", tab: "messages", type: "app_home_opened" })
    )
  ).toEqual({ kind: "ignored", reason: "unsupported_event" });
});

test("a payload that is neither shape is malformed, and says why", () => {
  const event = parseEvent({ type: "event_callback" });
  expect(event.kind).toBe("malformed");
  expect(event).toHaveProperty("detail");
  expect(parseEvent(null).kind).toBe("malformed");
  expect(parseEvent("nonsense").kind).toBe("malformed");
});

test("an inner message that does not match its own schema is malformed", () => {
  expect(
    parseEvent(callback({ channel_type: "im", type: "message" })).kind
  ).toBe("malformed");
});
