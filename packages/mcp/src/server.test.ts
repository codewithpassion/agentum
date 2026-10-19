import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { McpPorts } from "./ports";
import { errorResult } from "./result";
import {
  createHarbourmasterMcpServer,
  type ServerOptions,
  TOOL_NAMES,
} from "./server";
import { connectClient, textOf } from "./testing";

const SKILL_READ_NAMES = [
  "export_skill",
  "list_skills",
  "skill_diff",
  "skill_log",
  "skill_show",
];

const SKILL_WRITE_NAMES = [
  "approve_skill_version",
  "assign_skill",
  "commit_skill",
  "create_skill",
  "import_skill",
  "pin_skill",
  "reject_skill_version",
  "revert_skill",
  "unassign_skill",
];

const SLACK_READ_NAMES = [
  "slack_destinations",
  "slack_history",
  "slack_search",
];

const SLACK_WRITE_NAMES = ["slack_send"];

const EXPECTED_NAMES = [
  "bash",
  "create_routine",
  "create_trigger",
  "delete_routine",
  "delete_trigger",
  "get_run",
  "inbox_list",
  "inbox_post",
  "inbox_read",
  "list_agents",
  "list_routines",
  "list_sessions",
  "list_triggers",
  "read_session",
  "search_sessions",
  "send_message",
  "set_routine_enabled",
  "set_trigger_enabled",
  ...SKILL_READ_NAMES,
  ...SKILL_WRITE_NAMES,
  ...SLACK_READ_NAMES,
  ...SLACK_WRITE_NAMES,
].sort();

const READ_NAMES = [
  "get_run",
  "inbox_list",
  "inbox_read",
  "list_agents",
  "list_routines",
  "list_sessions",
  "list_triggers",
  "read_session",
  "search_sessions",
  ...SKILL_READ_NAMES,
  ...SLACK_READ_NAMES,
].sort();

const uncalled = (): Promise<never> =>
  Promise.reject(new Error("this port should not be called"));

const fakePorts: McpPorts = {
  approveSkillVersion: uncalled,
  assignSkill: uncalled,
  commitSkill: uncalled,
  createRoutine: uncalled,
  createSkill: uncalled,
  createTrigger: uncalled,
  deleteRoutine: uncalled,
  deleteTrigger: uncalled,
  exportSkill: uncalled,
  getRun: uncalled,
  importSkill: uncalled,
  inboxList: uncalled,
  inboxPost: uncalled,
  inboxRead: uncalled,
  libraryBash: uncalled,
  listAgents: uncalled,
  listRoutines: uncalled,
  listSessions: uncalled,
  listSkills: uncalled,
  listTriggers: uncalled,
  pinSkill: uncalled,
  readSession: uncalled,
  rejectSkillVersion: uncalled,
  revertSkill: uncalled,
  searchSessions: uncalled,
  sendMessage: uncalled,
  setRoutineEnabled: uncalled,
  setTriggerEnabled: uncalled,
  skillDiff: uncalled,
  skillLog: uncalled,
  skillShow: uncalled,
  slackDestinations: uncalled,
  slackHistory: uncalled,
  slackSearch: uncalled,
  slackSend: uncalled,
  unassignSkill: uncalled,
};

const withClient = async (
  run: (client: Client) => Promise<void>,
  options: ServerOptions = {}
) => {
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(fakePorts, options)
  );
  try {
    await run(client);
  } finally {
    await close();
  }
};

describe("tools/list", () => {
  test("TOOL_NAMES lists every tool name", () => {
    expect([...TOOL_NAMES].sort()).toEqual(EXPECTED_NAMES);
    expect(TOOL_NAMES).toHaveLength(EXPECTED_NAMES.length);
  });

  test("serves exactly the expected tools", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_NAMES);
    }));

  test("marks only the read tools as read-only", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      const readOnly = tools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
        .sort();
      expect(readOnly).toEqual(READ_NAMES);
    }));

  test("a read-only caller gets the list tools for routines and triggers and no tool that changes them", () =>
    withClient(
      async (client) => {
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("list_routines");
        expect(names).toContain("list_triggers");
        for (const name of [
          "create_routine",
          "set_routine_enabled",
          "delete_routine",
          "create_trigger",
          "set_trigger_enabled",
          "delete_trigger",
        ]) {
          expect(names).not.toContain(name);
        }
      },
      { readOnly: true }
    ));

  test("a read-only caller gets the read tools for skills and none that change them", () =>
    withClient(
      async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of SKILL_READ_NAMES) {
          expect(names).toContain(name);
        }
        for (const name of SKILL_WRITE_NAMES) {
          expect(names).not.toContain(name);
        }
      },
      { readOnly: true }
    ));

  test("a read-only caller gets neither Slack tool", () =>
    withClient(
      async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of [...SLACK_READ_NAMES, ...SLACK_WRITE_NAMES]) {
          expect(names).not.toContain(name);
        }
      },
      { readOnly: true }
    ));

  test("gives the write tools a non-destructive hint", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const name of ["send_message", "inbox_post"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.annotations?.readOnlyHint).toBe(false);
        expect(tool?.annotations?.destructiveHint).toBe(false);
      }
    }));
});

describe("tools/call", () => {
  test("refuses an argument the schema does not declare", () =>
    withClient(async (client) => {
      const result = await client.callTool({
        arguments: { runId: "run_1", unexpected: 1 },
        name: "get_run",
      });
      expect(result.isError).toBe(true);
    }));
});

describe("errorResult", () => {
  test("gives a non-ToolError only the generic text", () => {
    const result = errorResult(new Error("secret db password"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The request failed. Try again; if it keeps failing, check Harbourmaster."
    );
    expect(textOf(result)).not.toContain("secret");
  });
});
