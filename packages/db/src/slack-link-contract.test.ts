import type { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SLACK_ROOM_DIRECTIONS } from "./shared.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const UNIQUE_FAILED = "UNIQUE constraint failed";

const seedWorkspace = (client: Sqlite, id: string) => {
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES (?, ?, ?, ?, 'UTC')`,
    [`org_${id}`, NOW, id, id]
  );
};

const seedTeam = (client: Sqlite, id: string, workspaceId: string) => {
  client.run(
    `INSERT INTO teams (created_at, id, name, slug, workspace_id)
     VALUES (?, ?, ?, ?, ?)`,
    [NOW, id, id, id, workspaceId]
  );
};

const link = (
  client: Sqlite,
  input: { channelId: string; id: string; slackTeamId: string; teamId: string }
) => {
  client.run(
    `INSERT INTO team_slack_links (channel_id, created_at, id, linked_by, slack_team_id, team_id, workspace_id)
     VALUES (?, ?, ?, 'u1', ?, ?, 'w1')`,
    [input.channelId, NOW, input.id, input.slackTeamId, input.teamId]
  );
};

const seedPost = (client: Sqlite, id: string) => {
  client.run(
    `INSERT INTO inbox_threads (created_at, created_by, id, last_post_at, title, workspace_id)
     VALUES (?, 'u1', 'th1', ?, 'room', 'w1')`,
    [NOW, NOW]
  );
  client.run(
    `INSERT INTO inbox_posts (author_id, author_kind, created_at, file_ids, id, run_id, text, thread_id, workspace_id)
     VALUES ('u1', 'user', ?, '[]', ?, NULL, 'hello', 'th1', 'w1')`,
    [NOW, id]
  );
};

const roomMessage = (
  client: Sqlite,
  input: {
    channelId?: string;
    direction?: string;
    id: string;
    postId: string;
    slackTeamId?: string;
    ts: string;
  }
) => {
  client.run(
    `INSERT INTO slack_room_messages (channel_id, created_at, direction, id, post_id, slack_team_id, thread_ts, ts, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'w1')`,
    [
      input.channelId ?? "C1",
      NOW,
      input.direction ?? "in",
      input.id,
      input.postId,
      input.slackTeamId ?? "T1",
      input.ts,
    ]
  );
};

const setup = () => {
  const { client } = migrated();
  seedWorkspace(client, "w1");
  seedTeam(client, "team1", "w1");
  seedTeam(client, "team2", "w1");
  return client;
};

test("a second team cannot link a channel another team has linked", () => {
  const client = setup();
  link(client, {
    channelId: "C1",
    id: "l1",
    slackTeamId: "T1",
    teamId: "team1",
  });
  expect(() =>
    link(client, {
      channelId: "C1",
      id: "l2",
      slackTeamId: "T1",
      teamId: "team2",
    })
  ).toThrow(UNIQUE_FAILED);
});

test("a team cannot link two channels", () => {
  const client = setup();
  link(client, {
    channelId: "C1",
    id: "l1",
    slackTeamId: "T1",
    teamId: "team1",
  });
  expect(() =>
    link(client, {
      channelId: "C2",
      id: "l2",
      slackTeamId: "T1",
      teamId: "team1",
    })
  ).toThrow(UNIQUE_FAILED);
});

test("the same channel id in another Slack workspace is a different channel", () => {
  const client = setup();
  link(client, {
    channelId: "C1",
    id: "l1",
    slackTeamId: "T1",
    teamId: "team1",
  });
  link(client, {
    channelId: "C1",
    id: "l2",
    slackTeamId: "T2",
    teamId: "team2",
  });
});

test("deleting a team deletes its Slack link, which frees the channel", () => {
  const client = setup();
  link(client, {
    channelId: "C1",
    id: "l1",
    slackTeamId: "T1",
    teamId: "team1",
  });
  client.run("DELETE FROM teams WHERE id = 'team1'");
  expect(client.query("SELECT id FROM team_slack_links").all()).toHaveLength(0);
  link(client, {
    channelId: "C1",
    id: "l2",
    slackTeamId: "T1",
    teamId: "team2",
  });
});

test("a Slack message maps to one room post", () => {
  const client = setup();
  seedPost(client, "p1");
  roomMessage(client, { id: "m1", postId: "p1", ts: "1.1" });
  expect(() =>
    roomMessage(client, { id: "m2", postId: "p1", ts: "1.1" })
  ).toThrow(UNIQUE_FAILED);
  roomMessage(client, { direction: "out", id: "m3", postId: "p1", ts: "1.2" });
  roomMessage(client, { id: "m4", postId: "p1", slackTeamId: "T2", ts: "1.1" });
});

test("deleting a post deletes its Slack message rows", () => {
  const client = setup();
  seedPost(client, "p1");
  roomMessage(client, { id: "m1", postId: "p1", ts: "1.1" });
  client.run("DELETE FROM inbox_posts WHERE id = 'p1'");
  expect(client.query("SELECT id FROM slack_room_messages").all()).toHaveLength(
    0
  );
});

test("the room message directions are in and out", () => {
  expect([...SLACK_ROOM_DIRECTIONS]).toEqual(["in", "out"]);
});
