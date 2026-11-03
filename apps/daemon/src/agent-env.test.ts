// Tests for the Claude Code child environment filter.

import { expect, test } from "bun:test";
import { buildAgentEnv } from "./agent-env.ts";

test("passes allowed names through unchanged", () => {
  const env = buildAgentEnv({
    HOME: "/home/hm",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin",
    TERM: "xterm",
    USER: "hm",
  });
  expect(env).toEqual({
    HOME: "/home/hm",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin",
    TERM: "xterm",
    USER: "hm",
  });
});

test("drops CLAUDECODE and CLAUDE_CODE_ENTRYPOINT", () => {
  const env = buildAgentEnv({
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDECODE: "1",
    PATH: "/usr/bin",
  });
  expect(env).toEqual({ PATH: "/usr/bin" });
});

test("passes CLAUDE_CONFIG_DIR and no other CLAUDE_ name", () => {
  const env = buildAgentEnv({
    CLAUDE_CODE_BRIDGE_SESSION_ID: "bridge",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    CLAUDE_CONFIG_DIR: "/home/hm/.claude",
    CLAUDE_PID: "42",
  });
  expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/hm/.claude" });
});

test("passes XDG_ names", () => {
  const env = buildAgentEnv({ XDG_CONFIG_HOME: "/home/hm/.config" });
  expect(env).toEqual({ XDG_CONFIG_HOME: "/home/hm/.config" });
});

test("drops unknown names, including secret-shaped and Agentum ones", () => {
  const env = buildAgentEnv({
    AGENTUM_URL: "https://example.test",
    ANTHROPIC_API_KEY: "sk-ant-1",
    HM_CREDENTIAL: "x",
    PATH: "/usr/bin",
    SLACK_BOT_TOKEN: "xoxb-1",
  });
  expect(env).toEqual({ PATH: "/usr/bin" });
});

test("drops undefined values", () => {
  const env = buildAgentEnv({ HOME: undefined, PATH: "/usr/bin" });
  expect(env).toEqual({ PATH: "/usr/bin" });
  expect("HOME" in env).toBe(false);
});

test("does not mutate the input object", () => {
  const source = {
    CLAUDECODE: "1",
    HOME: "/home/hm",
    MISSING: undefined,
    SLACK_BOT_TOKEN: "xoxb-1",
  };
  const before = { ...source };
  buildAgentEnv(source);
  expect(source).toEqual(before);
});
