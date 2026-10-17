import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  McpPorts,
  RoutineInfo,
  TriggerChange,
  TriggerInfo,
} from "../ports";
import { registerTools } from "../register";
import { ToolError } from "../result";
import { connectClient, textOf } from "../testing";
import { routineTools } from "./routines";
import { triggerTools } from "./triggers";

const ROUTINE: RoutineInfo = {
  agentId: "agt_1",
  agentName: "Ops Bot",
  cron: "0 9 * * 1-5",
  id: "rtn_1",
  lastFiredAt: null,
  name: "Morning check",
  nextRunAt: "2026-10-19T07:00:00.000Z",
  prompt: "Check the deploys.",
  status: "active",
  timezone: "Europe/Zurich",
};

const PROPOSED_ROUTINE: RoutineInfo = {
  ...ROUTINE,
  id: "rtn_2",
  nextRunAt: null,
  status: "awaiting_approval",
};

const TRIGGER: TriggerInfo = {
  agentId: "agt_1",
  agentName: "Ops Bot",
  id: "trg_1",
  lastFiredAt: null,
  name: "Deploy hook",
  status: "active",
  tokenPrefix: "hm_trg_ab12",
};

const PROPOSED_TRIGGER: TriggerInfo = {
  ...TRIGGER,
  id: "trg_2",
  status: "awaiting_approval",
  tokenPrefix: "",
};

const SECRET = "hm_trg_ab12cd34ef56gh78";

/** Ports that answer what a test needs and reject any other call. */
const fakePorts = (overrides: Partial<McpPorts>): McpPorts =>
  ({
    createRoutine: uncalled("createRoutine"),
    createTrigger: uncalled("createTrigger"),
    deleteRoutine: uncalled("deleteRoutine"),
    deleteTrigger: uncalled("deleteTrigger"),
    listRoutines: uncalled("listRoutines"),
    listTriggers: uncalled("listTriggers"),
    setRoutineEnabled: uncalled("setRoutineEnabled"),
    setTriggerEnabled: uncalled("setTriggerEnabled"),
    ...overrides,
  }) as McpPorts;

function uncalled(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} should not be called`));
}

const callTool = async (
  ports: McpPorts,
  name: string,
  args: Record<string, unknown>
) => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, [...routineTools(ports), ...triggerTools(ports)]);
  const { client, close } = await connectClient(server);
  try {
    return await client.callTool({ arguments: args, name });
  } finally {
    await close();
  }
};

const listTools = async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, [
    ...routineTools(fakePorts({})),
    ...triggerTools(fakePorts({})),
  ]);
  const { client, close } = await connectClient(server);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await close();
  }
};

describe("automation tools: names and annotations", () => {
  test("registers the eight tools with the expected hints", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "create_routine",
        "create_trigger",
        "delete_routine",
        "delete_trigger",
        "list_routines",
        "list_triggers",
        "set_routine_enabled",
        "set_trigger_enabled",
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.annotations).toBeDefined();
      if (tool.name.startsWith("list_")) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      if (tool.name.startsWith("delete_")) {
        expect(tool.annotations?.destructiveHint).toBe(true);
      }
    }
  });
});

describe("automation tools: inputs and results", () => {
  test("list_routines passes agentId to the port and renders the routines", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        listRoutines: (input) => {
          received = input;
          return Promise.resolve([ROUTINE]);
        },
      }),
      "list_routines",
      { agentId: "ops-bot" }
    );
    expect(received).toEqual({ agentId: "ops-bot" });
    expect(result.structuredContent).toEqual({ routines: [ROUTINE] });
    expect(textOf(result)).toContain("rtn_1 active");
  });

  test("create_routine trims its input and returns the routine", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        createRoutine: (input) => {
          received = input;
          return Promise.resolve(ROUTINE);
        },
      }),
      "create_routine",
      {
        agentId: "agt_1",
        cron: " 0 9 * * 1-5 ",
        name: "  Morning check ",
        prompt: "Check the deploys.",
        timezone: "Europe/Zurich",
      }
    );
    expect(received).toEqual({
      agentId: "agt_1",
      cron: "0 9 * * 1-5",
      name: "Morning check",
      prompt: "Check the deploys.",
      timezone: "Europe/Zurich",
    });
    expect(result.structuredContent).toEqual({ routine: ROUTINE });
    expect(textOf(result)).not.toContain("approve");
  });

  test("an awaiting_approval routine says it waits for approval on the Routines page", async () => {
    const result = await callTool(
      fakePorts({ createRoutine: () => Promise.resolve(PROPOSED_ROUTINE) }),
      "create_routine",
      { agentId: "agt_1", cron: "*/15 * * * *", name: "Poll", prompt: "Poll." }
    );
    expect(textOf(result)).toContain(
      "It is stored off and waits for a person to approve it in the Harbourmaster UI (Routines page)."
    );
  });

  test("set_routine_enabled passes the flag and renders the routine", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        setRoutineEnabled: (input) => {
          received = input;
          return Promise.resolve({ ...ROUTINE, status: "paused" });
        },
      }),
      "set_routine_enabled",
      { enabled: false, routineId: "rtn_1" }
    );
    expect(received).toEqual({ enabled: false, routineId: "rtn_1" });
    expect(result.structuredContent).toEqual({
      routine: { ...ROUTINE, status: "paused" },
    });
  });

  test("delete_routine passes the id and reports it deleted", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        deleteRoutine: (input) => {
          received = input;
          return Promise.resolve();
        },
      }),
      "delete_routine",
      { routineId: "rtn_1" }
    );
    expect(received).toEqual({ routineId: "rtn_1" });
    expect(result.structuredContent).toEqual({ deleted: "rtn_1" });
  });

  test("list_triggers shows the token prefix and never the secret", async () => {
    const result = await callTool(
      fakePorts({
        listTriggers: () => Promise.resolve([TRIGGER, PROPOSED_TRIGGER]),
      }),
      "list_triggers",
      {}
    );
    expect(result.structuredContent).toEqual({
      triggers: [TRIGGER, PROPOSED_TRIGGER],
    });
    expect(textOf(result)).toContain("hm_trg_ab12...");
    expect(textOf(result)).toContain(
      "It is stored off and waits for a person to approve it in the Harbourmaster UI (Triggers page)."
    );
  });

  test("create_trigger with a secret shows it once in data and text", async () => {
    const change: TriggerChange = { secret: SECRET, trigger: TRIGGER };
    const result = await callTool(
      fakePorts({ createTrigger: () => Promise.resolve(change) }),
      "create_trigger",
      { agentId: "agt_1", name: "Deploy hook" }
    );
    expect(result.structuredContent).toEqual({
      secret: SECRET,
      trigger: TRIGGER,
    });
    const text = textOf(result);
    expect(text).toContain(`Secret (shown once, store it now): ${SECRET}`);
    expect(text.split(SECRET)).toHaveLength(2);
  });

  test("create_trigger with a null secret has no secret key and no token text", async () => {
    const result = await callTool(
      fakePorts({
        createTrigger: () =>
          Promise.resolve({ secret: null, trigger: PROPOSED_TRIGGER }),
      }),
      "create_trigger",
      { agentId: "agt_1", name: "Deploy hook" }
    );
    expect(result.structuredContent).toEqual({ trigger: PROPOSED_TRIGGER });
    expect(result.structuredContent).not.toHaveProperty("secret");
    expect(textOf(result)).not.toContain("hm_trg_");
    expect(textOf(result)).not.toContain("Secret");
    expect(textOf(result)).toContain(
      "It is stored off and waits for a person to approve it in the Harbourmaster UI (Triggers page)."
    );
  });

  test("set_trigger_enabled passes the flag and never shows a token", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        setTriggerEnabled: (input) => {
          received = input;
          return Promise.resolve({ secret: null, trigger: TRIGGER });
        },
      }),
      "set_trigger_enabled",
      { enabled: true, triggerId: "trg_1" }
    );
    expect(received).toEqual({ enabled: true, triggerId: "trg_1" });
    expect(result.structuredContent).toEqual({ trigger: TRIGGER });
    expect(textOf(result)).not.toContain("hm_trg_");
  });

  test("delete_trigger passes the id and reports it deleted", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        deleteTrigger: (input) => {
          received = input;
          return Promise.resolve();
        },
      }),
      "delete_trigger",
      { triggerId: "trg_1" }
    );
    expect(received).toEqual({ triggerId: "trg_1" });
    expect(result.structuredContent).toEqual({ deleted: "trg_1" });
  });
});

describe("automation tools: failures", () => {
  test("a port's forbidden ToolError comes back as an error result with its code", async () => {
    const result = await callTool(
      fakePorts({
        deleteRoutine: () =>
          Promise.reject(
            new ToolError(
              "forbidden",
              "Agents remove only their own proposals."
            )
          ),
      }),
      "delete_routine",
      { routineId: "rtn_1" }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "forbidden",
      message: "Agents remove only their own proposals.",
    });
  });

  test("an empty name is refused before the port runs", async () => {
    const result = await callTool(fakePorts({}), "create_trigger", {
      agentId: "agt_1",
      name: "   ",
    });
    expect(result.isError).toBe(true);
  });
});
