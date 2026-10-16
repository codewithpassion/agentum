import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { McpPorts } from "./ports";
import { errorResult } from "./result";
import { createHarbourmasterMcpServer, TOOL_NAMES } from "./server";
import { connectClient, textOf } from "./testing";

const EXPECTED_NAMES = [
  "get_run",
  "inbox_list",
  "inbox_post",
  "inbox_read",
  "list_agents",
  "list_sessions",
  "read_session",
  "search_sessions",
  "send_message",
].sort();

const READ_NAMES = [
  "get_run",
  "inbox_list",
  "inbox_read",
  "list_agents",
  "list_sessions",
  "read_session",
  "search_sessions",
].sort();

const uncalled = (): Promise<never> =>
  Promise.reject(new Error("this port should not be called"));

const fakePorts: McpPorts = {
  getRun: uncalled,
  inboxList: uncalled,
  inboxPost: uncalled,
  inboxRead: uncalled,
  listAgents: uncalled,
  listSessions: uncalled,
  readSession: uncalled,
  searchSessions: uncalled,
  sendMessage: uncalled,
};

const withClient = async (run: (client: Client) => Promise<void>) => {
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(fakePorts)
  );
  try {
    await run(client);
  } finally {
    await close();
  }
};

describe("tools/list", () => {
  test("TOOL_NAMES lists the nine tool names", () => {
    expect([...TOOL_NAMES].sort()).toEqual(EXPECTED_NAMES);
    expect(TOOL_NAMES).toHaveLength(9);
  });

  test("serves exactly the nine tools", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_NAMES);
    }));

  test("marks only the seven read tools as read-only", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      const readOnly = tools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
        .sort();
      expect(readOnly).toEqual(READ_NAMES);
    }));

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
