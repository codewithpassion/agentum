import { describe, expect, test } from "bun:test";
import {
  buildSlackManifest,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  slackEventsUrl,
} from "./manifest";

/**
 * The manifest is what the user pastes into Slack, so what matters is that it
 * names this app's own events URL, asks for exactly the scopes the bridge uses,
 * and stays parseable whatever the agent is called.
 */

const REQUEST_URL = "https://agentum.example.com/api/bridges/slack/app-1";

describe("slackEventsUrl", () => {
  test("prefers PUBLIC_APP_URL and trims its trailing slash", () => {
    expect(
      slackEventsUrl(
        "https://agentum.example.com/",
        "http://localhost:3720/x",
        "app-1"
      )
    ).toBe("https://agentum.example.com/api/bridges/slack/app-1");
  });

  test("falls back to the request's own origin", () => {
    expect(
      slackEventsUrl(
        undefined,
        "https://tunnel.example.com/api/w/a/agents",
        "app-2"
      )
    ).toBe("https://tunnel.example.com/api/bridges/slack/app-2");
  });
});

describe("buildSlackManifest", () => {
  test("carries the events URL, every scope and every subscribed event", () => {
    const manifest = buildSlackManifest({ name: "Ada" }, REQUEST_URL);

    expect(manifest).toContain(`request_url: "${REQUEST_URL}"`);
    for (const scope of SLACK_BOT_SCOPES) {
      expect(manifest).toContain(`- ${scope}`);
    }
    for (const event of SLACK_BOT_EVENTS) {
      expect(manifest).toContain(`- ${event}`);
    }
    expect(manifest).toContain("socket_mode_enabled: false");
    expect(manifest).toContain('name: "Ada"');
    expect(manifest).toContain('display_name: "Ada"');
  });

  test("enables interactivity, beside the events URL it is signed like", () => {
    const manifest = buildSlackManifest({ name: "Ada" }, REQUEST_URL);

    // Without this block Slack never delivers a button press, and a question
    // card is a picture of buttons.
    expect(manifest).toContain("interactivity:\n    is_enabled: true");
    expect(manifest).toContain(`request_url: "${REQUEST_URL}/interactive"`);
  });

  test("escapes a name that would otherwise break the YAML", () => {
    const manifest = buildSlackManifest(
      { name: 'Ops: "the second"' },
      REQUEST_URL
    );

    expect(manifest).toContain('name: "Ops: \\"the second\\""');
  });

  test("truncates to Slack's caps, and drops the periods a bot name may not have", () => {
    const manifest = buildSlackManifest(
      { name: `${"A".repeat(40)}.B` },
      REQUEST_URL
    );

    expect(manifest).toContain(`name: "${"A".repeat(35)}"`);
    expect(manifest).toContain(`display_name: "${"A".repeat(40)}B"`);
  });
});
