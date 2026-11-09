import { expect, test } from "bun:test";
import type { McpPorts, RunInfo } from "./ports";
import { agentumTools, createAgentumMcpServer } from "./server";
import { connectClient } from "./testing";

const run: RunInfo = {
  agentId: "agent",
  answer: null,
  error: null,
  runId: "child",
  sessionId: "child-session",
  status: "running",
};
const unused = (): Promise<never> =>
  Promise.reject(new Error("Unexpected call"));
const ports = new Proxy(
  {
    subagents: {
      list: async () => [{ ...run, model: "haiku", summary: "Read the files" }],
      message: async () => run,
      start: async () => run,
      status: async () => run,
      stop: async () => ({ ...run, status: "cancelled" }),
    },
  },
  {
    get(target, key) {
      if (key === "subagents") {
        return target.subagents;
      }
      return unused;
    },
  }
) as unknown as McpPorts;

const names = (start?: boolean) =>
  agentumTools(ports, {
    ...(start === undefined ? {} : { subagents: { start } }),
  }).map((tool) => tool.name);

test("subagent tools are absent when the switch is off", () => {
  expect(names().filter((name) => name.includes("subagent"))).toEqual([]);
});

test("a level-2 subagent can manage helpers but cannot start another", () => {
  expect(names(false)).not.toContain("start_subagent");
  expect(names(false)).toContain("subagent_status");
  expect(names(true)).toContain("start_subagent");
});

test("subagents reuse the run payload and direct pending checks to subagent_status", async () => {
  const tool = agentumTools(ports, { subagents: { start: true } }).find(
    (entry) => entry.name === "start_subagent"
  );
  const result = await tool?.run({ model: "haiku", task: "Read" });
  expect(result?.data).toMatchObject({ runId: "child", state: "pending" });
  expect(result?.text).toContain("Check it with subagent_status");
});

test("platform tools remain available beside narrowed connector tools", async () => {
  const server = createAgentumMcpServer(ports, { subagents: { start: true } });
  const { client } = await connectClient(server);
  const offered = (await client.listTools()).tools.map((tool) => tool.name);
  expect(offered).toContain("subagent_status");
  expect(offered).toContain("start_subagent");
  expect(offered).toContain("get_run");
  await client.close();
});

test("disabled agents can still manage helpers without sending new work", () => {
  const offered = agentumTools(ports, {
    subagents: { message: false, start: false },
  }).map((tool) => tool.name);
  expect(offered).not.toContain("start_subagent");
  expect(offered).not.toContain("message_subagent");
  expect(offered).toContain("subagent_status");
  expect(offered).toContain("stop_subagent");
  expect(offered).toContain("list_subagents");
});
