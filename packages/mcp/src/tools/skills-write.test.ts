import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import type { McpPorts, SkillVersionInfo } from "../ports";
import { registerTools } from "../register";
import { ToolError } from "../result";
import { connectClient, textOf } from "../testing";
import { skillWriteTools } from "./skills-write";

const VERSION: SkillVersionInfo = {
  approvedAt: "2026-10-18T08:00:00.000Z",
  authorKind: "user",
  createdAt: "2026-10-18T08:00:00.000Z",
  message: "Add the deploy check.",
  number: 3,
  parent: 2,
  skillId: "skl_1",
  skillName: "Deploy check",
  status: "approved",
};

const PROPOSED: SkillVersionInfo = {
  ...VERSION,
  approvedAt: null,
  authorKind: "agent",
  number: 4,
  status: "proposed",
};

const ASSIGNMENT = {
  agentId: "agt_1",
  pinnedVersion: null,
  skillId: "skl_1",
};

const FILE = { content: "echo ok\n", path: "scripts/run.sh" };

/** Ports that answer what a test needs and reject any other call. */
const fakePorts = (overrides: Partial<McpPorts>): McpPorts =>
  ({
    approveSkillVersion: uncalled("approveSkillVersion"),
    assignSkill: uncalled("assignSkill"),
    commitSkill: uncalled("commitSkill"),
    createSkill: uncalled("createSkill"),
    deleteSkill: uncalled("deleteSkill"),
    importSkill: uncalled("importSkill"),
    pinSkill: uncalled("pinSkill"),
    rejectSkillVersion: uncalled("rejectSkillVersion"),
    revertSkill: uncalled("revertSkill"),
    unassignSkill: uncalled("unassignSkill"),
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
  registerTools(server, skillWriteTools(ports));
  const { client, close } = await connectClient(server);
  try {
    return await client.callTool({ arguments: args, name });
  } finally {
    await close();
  }
};

const listTools = async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, skillWriteTools(fakePorts({})));
  const { client, close } = await connectClient(server);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await close();
  }
};

describe("skill write tools: names and annotations", () => {
  test("registers the nine tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
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
      ].sort()
    );
  });

  test("create, commit, revert and import are creating writes", async () => {
    const tools = await listTools();
    for (const name of [
      "create_skill",
      "commit_skill",
      "revert_skill",
      "import_skill",
    ]) {
      const tool = tools.find((item) => item.name === name);
      expect(tool?.annotations).toEqual({
        destructiveHint: false,
        idempotentHint: false,
        readOnlyHint: false,
      });
    }
  });

  test("unassign and delete are destructive and no tool is read-only", async () => {
    const tools = await listTools();
    for (const name of ["unassign_skill", "delete_skill"]) {
      const tool = tools.find((item) => item.name === name);
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).not.toBe(true);
    }
  });

  test("the commit description says a stale base is refused", async () => {
    const tools = await listTools();
    const commit = tools.find((tool) => tool.name === "commit_skill");
    expect(commit?.description).toContain("stale base");
  });
});

describe("skill write tools: inputs reach the ports", () => {
  test("create_skill passes the files, with encoding defaulted to utf8", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        createSkill: (input) => {
          received = input;
          return Promise.resolve(VERSION);
        },
      }),
      "create_skill",
      { files: [FILE], message: "First cut.", name: "Deploy check" }
    );
    expect(received).toEqual({
      files: [
        { content: "echo ok\n", encoding: "utf8", path: "scripts/run.sh" },
      ],
      message: "First cut.",
      name: "Deploy check",
    });
    expect(result.structuredContent).toEqual({ version: VERSION });
  });

  test("commit_skill defaults writes and deletes to empty lists", async () => {
    let received: unknown;
    await callTool(
      fakePorts({
        commitSkill: (input) => {
          received = input;
          return Promise.resolve(VERSION);
        },
      }),
      "commit_skill",
      { baseVersion: 2, message: "Tidy.", skillId: "skl_1" }
    );
    expect(received).toEqual({
      baseVersion: 2,
      deletes: [],
      message: "Tidy.",
      skillId: "skl_1",
      writes: [],
    });
  });

  test("commit_skill passes writes, deletes and a binary encoding through", async () => {
    let received: unknown;
    await callTool(
      fakePorts({
        commitSkill: (input) => {
          received = input;
          return Promise.resolve(VERSION);
        },
      }),
      "commit_skill",
      {
        baseVersion: 2,
        deletes: ["old.txt"],
        message: "Add an icon.",
        skillId: "skl_1",
        writes: [
          { content: "iVBORw0KGgo=", encoding: "base64", path: "icon.png" },
        ],
      }
    );
    expect(received).toEqual({
      baseVersion: 2,
      deletes: ["old.txt"],
      message: "Add an icon.",
      skillId: "skl_1",
      writes: [
        { content: "iVBORw0KGgo=", encoding: "base64", path: "icon.png" },
      ],
    });
  });

  test("revert_skill passes toVersion and no message when none is given", async () => {
    let received: unknown;
    await callTool(
      fakePorts({
        revertSkill: (input) => {
          received = input;
          return Promise.resolve(VERSION);
        },
      }),
      "revert_skill",
      { skillId: "skl_1", toVersion: 1 }
    );
    expect(received).toEqual({ skillId: "skl_1", toVersion: 1 });
  });

  test("import_skill passes the archive and returns created and name", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        importSkill: (input) => {
          received = input;
          return Promise.resolve({
            created: true,
            name: "Deploy check",
            version: VERSION,
          });
        },
      }),
      "import_skill",
      { archiveBase64: "UEsDBA==" }
    );
    expect(received).toEqual({ archiveBase64: "UEsDBA==" });
    expect(result.structuredContent).toEqual({
      created: true,
      name: "Deploy check",
      version: VERSION,
    });
    expect(textOf(result)).toContain("Imported version 3");
  });

  test("approve_skill_version and reject_skill_version pass skillId and version", async () => {
    const seen: unknown[] = [];
    const ports = fakePorts({
      approveSkillVersion: (input) => {
        seen.push(input);
        return Promise.resolve(VERSION);
      },
      rejectSkillVersion: (input) => {
        seen.push(input);
        return Promise.resolve({ ...PROPOSED, status: "rejected" });
      },
    });
    const approved = await callTool(ports, "approve_skill_version", {
      skillId: "skl_1",
      version: 3,
    });
    const rejected = await callTool(ports, "reject_skill_version", {
      skillId: "skl_1",
      version: 4,
    });
    expect(seen).toEqual([
      { skillId: "skl_1", version: 3 },
      { skillId: "skl_1", version: 4 },
    ]);
    expect(textOf(approved)).toBe(
      'Approved version 3 of "Deploy check" (skl_1).'
    );
    expect(textOf(rejected)).toBe(
      'Rejected version 4 of "Deploy check" (skl_1).'
    );
  });

  test("assign_skill and unassign_skill pass agent and skillId", async () => {
    const seen: unknown[] = [];
    const ports = fakePorts({
      assignSkill: (input) => {
        seen.push(input);
        return Promise.resolve(ASSIGNMENT);
      },
      unassignSkill: (input) => {
        seen.push(input);
        return Promise.resolve();
      },
    });
    const assigned = await callTool(ports, "assign_skill", {
      agent: "ops-bot",
      skillId: "skl_1",
    });
    const unassigned = await callTool(ports, "unassign_skill", {
      agent: "ops-bot",
      skillId: "skl_1",
    });
    expect(seen).toEqual([
      { agent: "ops-bot", skillId: "skl_1" },
      { agent: "ops-bot", skillId: "skl_1" },
    ]);
    expect(assigned.structuredContent).toEqual({ assignment: ASSIGNMENT });
    expect(textOf(assigned)).toBe('Assigned "skl_1" to ops-bot.');
    expect(unassigned.structuredContent).toEqual({
      unassigned: { agent: "ops-bot", skillId: "skl_1" },
    });
  });

  test("delete_skill passes skillId and says what was removed", async () => {
    const seen: unknown[] = [];
    const ports = fakePorts({
      deleteSkill: (input) => {
        seen.push(input);
        return Promise.resolve();
      },
    });
    const deleted = await callTool(ports, "delete_skill", { skillId: "skl_1" });
    expect(seen).toEqual([{ skillId: "skl_1" }]);
    expect(deleted.structuredContent).toEqual({
      deleted: { skillId: "skl_1" },
    });
    expect(textOf(deleted)).toBe(
      'Deleted "skl_1" with all its versions, files and assignments.'
    );
  });

  test("pin_skill passes a version, and null follows the latest approved version", async () => {
    const seen: unknown[] = [];
    const ports = fakePorts({
      pinSkill: (input) => {
        seen.push(input);
        return Promise.resolve({
          ...ASSIGNMENT,
          pinnedVersion: input.version,
        });
      },
    });
    const pinned = await callTool(ports, "pin_skill", {
      agent: "ops-bot",
      skillId: "skl_1",
      version: 3,
    });
    const unpinned = await callTool(ports, "pin_skill", {
      agent: "ops-bot",
      skillId: "skl_1",
      version: null,
    });
    expect(seen).toEqual([
      { agent: "ops-bot", skillId: "skl_1", version: 3 },
      { agent: "ops-bot", skillId: "skl_1", version: null },
    ]);
    expect(textOf(pinned)).toBe('Pinned "skl_1" for ops-bot to version 3.');
    expect(textOf(unpinned)).toBe(
      'Unpinned "skl_1" for ops-bot: the agent follows the latest approved version.'
    );
  });
});

describe("skill write tools: proposal text", () => {
  const PROPOSED_SENTENCE =
    "Version 4 is proposed. It stays unused until a person approves it in the Agentum UI. To test it, read it with skill_show (version 4) and run its scripts with run_skill_script, passing version 4.";

  test("a proposed version says it is proposed, with its number", async () => {
    const result = await callTool(
      fakePorts({
        commitSkill: () => Promise.resolve(PROPOSED),
      }),
      "commit_skill",
      { baseVersion: 3, message: "Agent change.", skillId: "skl_1" }
    );
    expect(textOf(result)).toContain(PROPOSED_SENTENCE);
    expect(textOf(result)).toContain("status proposed.");
  });

  test("an approved version does not mention a proposal", async () => {
    const result = await callTool(
      fakePorts({
        revertSkill: () => Promise.resolve(VERSION),
      }),
      "revert_skill",
      { skillId: "skl_1", toVersion: 1 }
    );
    expect(textOf(result)).toBe(
      'Reverted version 3 of "Deploy check" (skl_1), status approved.'
    );
  });

  test("create_skill and import_skill share the proposal sentence", async () => {
    const created = await callTool(
      fakePorts({ createSkill: () => Promise.resolve(PROPOSED) }),
      "create_skill",
      { files: [FILE], message: "Draft.", name: "Deploy check" }
    );
    const imported = await callTool(
      fakePorts({
        importSkill: () =>
          Promise.resolve({
            created: false,
            name: "Deploy check",
            version: PROPOSED,
          }),
      }),
      "import_skill",
      { archiveBase64: "UEsDBA==" }
    );
    expect(textOf(created)).toContain(PROPOSED_SENTENCE);
    expect(textOf(imported)).toContain(PROPOSED_SENTENCE);
  });
});

describe("skill write tools: failures", () => {
  test("a stale base comes back as a conflict error with the port's message", async () => {
    const result = await callTool(
      fakePorts({
        commitSkill: () =>
          Promise.reject(
            new ToolError(
              "conflict",
              "The base version 2 is stale. Read the latest version and try again."
            )
          ),
      }),
      "commit_skill",
      { baseVersion: 2, message: "Late change.", skillId: "skl_1" }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "conflict",
      message:
        "The base version 2 is stale. Read the latest version and try again.",
    });
  });

  test("a forbidden approval comes back as a forbidden error", async () => {
    const result = await callTool(
      fakePorts({
        approveSkillVersion: () =>
          Promise.reject(
            new ToolError("forbidden", "Only people approve skill versions.")
          ),
      }),
      "approve_skill_version",
      { skillId: "skl_1", version: 4 }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "forbidden",
      message: "Only people approve skill versions.",
    });
  });

  test("a file write with an unknown encoding is refused before the port runs", async () => {
    const result = await callTool(fakePorts({}), "create_skill", {
      files: [{ content: "x", encoding: "hex", path: "a.txt" }],
      message: "Draft.",
      name: "Deploy check",
    });
    expect(result.isError).toBe(true);
  });
});
