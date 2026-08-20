import { describe, expect, test } from "bun:test";
import type { SlackApp } from "./api";
import { slackConnectHint, slackWizardStep } from "./slack-wizard";

const app = (overrides: Partial<SlackApp> = {}): SlackApp => ({
  agentId: "agent-1",
  botUserId: null,
  createdAt: new Date(0),
  id: "app-1",
  lastError: null,
  status: "draft",
  teamId: null,
  teamName: null,
  updatedAt: new Date(0),
  ...overrides,
});

describe("slackWizardStep", () => {
  test("no app is the first step", () => {
    expect(slackWizardStep(null)).toBe("create");
  });

  test("a draft is waiting for its tokens", () => {
    expect(slackWizardStep(app())).toBe("connect");
  });

  test("a rejected paste stays on the token step, not back at the start", () => {
    expect(
      slackWizardStep(app({ lastError: "invalid_auth", status: "error" }))
    ).toBe("connect");
  });

  test("an active app is done", () => {
    expect(
      slackWizardStep(
        app({ botUserId: "U1", status: "active", teamName: "Acme" })
      )
    ).toBe("done");
  });
});

describe("slackConnectHint", () => {
  test("says the stored tokens survive a failed retry", () => {
    expect(slackConnectHint(app({ status: "error" }))).toContain(
      "keep working"
    );
  });

  test("a draft has nothing to preserve", () => {
    expect(slackConnectHint(app())).not.toContain("keep working");
  });
});
