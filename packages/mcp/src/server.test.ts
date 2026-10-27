import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { McpPorts } from "./ports";
import { errorResult } from "./result";
import {
  createHarbourmasterMcpServer,
  harbourmasterTools,
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
  "delete_skill",
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

const LIVE_READ_NAMES = ["document_read", "document_comments"];
const LIVE_WRITE_NAMES = ["document_edit", "document_comment"];

const ARTIFACT_READ_NAMES = ["artifact_list", "artifact_read", "artifact_test"];
const ARTIFACT_WRITE_NAMES = [
  "artifact_create",
  "artifact_promote",
  "artifact_update",
];

const EXPECTED_NAMES = [
  "library_list",
  "library_read",
  "library_write",
  "library_versions",
  "wiki_read",
  "wiki_suggest_edit",
  "bash",
  "cancel_run",
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
  ...LIVE_READ_NAMES,
  ...ARTIFACT_READ_NAMES,
  ...LIVE_WRITE_NAMES,
  ...ARTIFACT_WRITE_NAMES,
  ...SKILL_READ_NAMES,
  ...SKILL_WRITE_NAMES,
  ...SLACK_READ_NAMES,
  ...SLACK_WRITE_NAMES,
].sort();

const READ_NAMES = [
  "library_list",
  "library_read",
  "library_versions",
  "wiki_read",
  "get_run",
  "inbox_list",
  "inbox_read",
  "list_agents",
  "list_routines",
  "list_sessions",
  "list_triggers",
  "read_session",
  "search_sessions",
  ...LIVE_READ_NAMES,
  ...ARTIFACT_READ_NAMES,
  ...SKILL_READ_NAMES,
  ...SLACK_READ_NAMES,
].sort();

const uncalled = (): Promise<never> =>
  Promise.reject(new Error("this port should not be called"));

const fakePorts: McpPorts = {
  approveSkillVersion: uncalled,
  artifacts: {
    create: uncalled,
    list: uncalled,
    promote: uncalled,
    read: uncalled,
    test: uncalled,
    update: uncalled,
  },
  assignSkill: uncalled,
  cancelRun: uncalled,
  commitSkill: uncalled,
  createRoutine: uncalled,
  createSkill: uncalled,
  createTrigger: uncalled,
  deleteRoutine: uncalled,
  deleteSkill: uncalled,
  deleteTrigger: uncalled,
  exportSkill: uncalled,
  getRun: uncalled,
  importSkill: uncalled,
  inboxList: uncalled,
  inboxPost: uncalled,
  inboxRead: uncalled,
  libraryBash: uncalled,
  libraryList: uncalled,
  libraryRead: uncalled,
  libraryVersions: uncalled,
  libraryWrite: uncalled,
  listAgents: uncalled,
  listRoutines: uncalled,
  listSessions: uncalled,
  listSkills: uncalled,
  listTriggers: uncalled,
  live: {
    comment: uncalled,
    comments: uncalled,
    create: uncalled,
    edit: uncalled,
    read: uncalled,
  },
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
  wikiRead: uncalled,
  wikiSuggestEdit: uncalled,
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

  test("cancel_run is listed for a write caller only", () => {
    const names = (readOnly: boolean) =>
      harbourmasterTools(fakePorts, { readOnly }).map((tool) => tool.name);
    expect(names(false)).toContain("cancel_run");
    expect(names(true)).not.toContain("cancel_run");
  });

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

describe("computer and browser capabilities", () => {
  test("requires opt-in and a port and never offers takeover", () => {
    const ports: McpPorts = {
      ...fakePorts,
      browser: {
        click: uncalled,
        fill: uncalled,
        navigate: uncalled,
        screenshot: uncalled,
        snapshot: uncalled,
      },
      computer: {
        desktopInput: uncalled,
        exec: uncalled,
        listDir: uncalled,
        readFile: uncalled,
        screenshot: uncalled,
        writeFile: uncalled,
      },
    };
    for (const computer of [undefined, { desktop: false }, { desktop: true }]) {
      for (const browser of [false, true]) {
        for (const readOnly of [false, true]) {
          for (const bound of [fakePorts, ports]) {
            const names = harbourmasterTools(bound, {
              browser,
              computer,
              readOnly,
            }).map((tool) => tool.name);
            expect(names.includes("computer_exec")).toBe(
              Boolean(computer && bound.computer && !readOnly)
            );
            expect(names.includes("desktop_input")).toBe(
              Boolean(computer?.desktop && bound.computer && !readOnly)
            );
            expect(names.includes("browser_snapshot")).toBe(
              Boolean(browser && bound.browser && !readOnly)
            );
            expect(names).not.toContain("request_human_takeover");
            expect(names).not.toContain("desktop_screenshot");
          }
        }
      }
    }
  });
});

test("computer and browser calls work over MCP and writes respect dry run", async () => {
  const writes: unknown[] = [];
  const ports: McpPorts = {
    ...fakePorts,
    browser: {
      click: uncalled,
      fill: uncalled,
      navigate: uncalled,
      screenshot: () =>
        Promise.resolve({
          image: { data: "aGk=", mimeType: "image/png" },
          ok: true,
          pageUrl: "https://example.com",
        }),
      snapshot: uncalled,
    },
    computer: {
      desktopInput: uncalled,
      exec: uncalled,
      listDir: uncalled,
      readFile: (input) =>
        Promise.resolve({
          content: input.path,
          ok: true,
          size: input.path.length,
        }),
      screenshot: uncalled,
      writeFile: (input) => {
        writes.push(input);
        return Promise.resolve({
          created: true,
          ok: true,
          size: input.content.length,
        });
      },
    },
  };
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(ports, {
      browser: true,
      computer: { desktop: true },
    })
  );
  try {
    const read = await client.callTool({
      arguments: { path: "//notes///" },
      name: "computer_read_file",
    });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toEqual({
      content: "/notes",
      path: "/notes",
      size: 6,
    });
    expect(
      (
        await client.callTool({
          arguments: { path: "/../a" },
          name: "computer_read_file",
        })
      ).isError
    ).toBe(true);
    const shot = await client.callTool({
      arguments: {},
      name: "browser_screenshot",
    });
    expect(shot.content).toContainEqual({
      data: "aGk=",
      mimeType: "image/png",
      type: "image",
    });
  } finally {
    await close();
  }
  const skipped: unknown[] = [];
  const dry = await connectClient(
    createHarbourmasterMcpServer(ports, {
      browser: true,
      computer: { desktop: true },
      dryRun: {
        record: (skip) => {
          skipped.push(skip);
          return Promise.resolve();
        },
      },
    })
  );
  try {
    const result = await dry.client.callTool({
      arguments: { content: "hi", path: "/a" },
      name: "computer_write_file",
    });
    expect(result.structuredContent).toMatchObject({ skipped: true });
    expect(writes).toEqual([]);
    expect(skipped).toHaveLength(1);
    const read = await dry.client.callTool({
      arguments: { path: "/a" },
      name: "computer_read_file",
    });
    expect(read.structuredContent).toMatchObject({ content: "/a" });
  } finally {
    await dry.close();
  }
});
