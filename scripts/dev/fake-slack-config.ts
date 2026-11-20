// The one Slack workspace that `fake-slack.ts` plays and `seed-slack-room.ts`
// seeds: three agents with their own Slack apps, three channels (the room, one Dev Person is not in, one private), and two people.
// The seed stores each app's token and signing secret, and the fake answers to
// the same ones, so the app and the fake agree without a config file.
import type {
  FakeSlackApp,
  FakeSlackConfig,
} from "@repo/services/slack/fake-slack";

export const SLACK_TEAM_ID = "T0SL5LOCAL";
export const CHANNEL_ID = "C0SL5ROOM";
export const CHANNEL_NAME = "sl5-room";
/** The Slack user who is linked to the dev user. */
export const DEV_SLACK_USER = "U0DEVPERSON";
/** A Slack user with no Agentum link, who posts as a guest. */
export const GUEST_SLACK_USER = "U0GUESTGUS";
export const DEV_PERSON_NAME = "Dev Person";
export const DEV_PERSON_EMAIL = "dev-person@example.test";
export const GUEST_NAME = "Gus Guest";

export interface SeededAgent {
  app: FakeSlackApp;
  name: string;
  slug: string;
}

const appOf = (slug: string, name: string): SeededAgent => {
  const id = slug.toUpperCase();
  return {
    app: {
      appId: `A0${id}LOCAL`,
      botId: `B0${id}LOCAL`,
      botUserId: `U0${id}LOCALBOT`,
      name,
      signingSecret: `local-signing-${slug}`,
      token: `xoxb-local-${slug}`,
    },
    name,
    slug,
  };
};

/** Ada leads the team. Di's app starts outside the channel. */
export const SEEDED_AGENTS: readonly SeededAgent[] = [
  appOf("ada", "Ada"),
  appOf("cy", "Cy"),
  appOf("di", "Di"),
];

/** The fake's starting state: Di's app has not been invited to the channel. */
export const fakeSlackConfig = (): FakeSlackConfig => ({
  apps: SEEDED_AGENTS.map((agent) => agent.app),
  channels: [
    {
      id: CHANNEL_ID,
      isPrivate: false,
      members: [
        DEV_SLACK_USER,
        GUEST_SLACK_USER,
        ...SEEDED_AGENTS.slice(0, 2).map((agent) => agent.app.botUserId),
      ],
      name: CHANNEL_NAME,
    },
    // Both have the lead's and Cy's apps. Dev Person is not in the first, and the second is private.
    {
      id: "C0SL5OUTSIDE",
      isPrivate: false,
      members: [
        GUEST_SLACK_USER,
        ...SEEDED_AGENTS.slice(0, 2).map((agent) => agent.app.botUserId),
      ],
      name: "sl5-outside",
    },
    {
      id: "G0SL5SECRET",
      isPrivate: true,
      members: [
        DEV_SLACK_USER,
        ...SEEDED_AGENTS.slice(0, 2).map((agent) => agent.app.botUserId),
      ],
      name: "sl5-secret",
    },
  ],
  slackTeamId: SLACK_TEAM_ID,
  users: [
    { email: DEV_PERSON_EMAIL, id: DEV_SLACK_USER, name: DEV_PERSON_NAME },
    { email: "gus@example.test", id: GUEST_SLACK_USER, name: GUEST_NAME },
  ],
});
