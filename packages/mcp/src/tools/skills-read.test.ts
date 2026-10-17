import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  McpPorts,
  SkillDiffInfo,
  SkillInfo,
  SkillShown,
  SkillVersionInfo,
} from "../ports";
import { registerTools } from "../register";
import { ToolError } from "../result";
import { connectClient, textOf } from "../testing";
import { skillReadTools } from "./skills-read";

const SKILL: SkillInfo = {
  assignedTo: [
    {
      agentId: "agt_1",
      name: "Ops Bot",
      pinned: false,
      slug: "ops-bot",
      version: 3,
    },
    {
      agentId: "agt_2",
      name: "Mailer",
      pinned: true,
      slug: "mailer",
      version: 2,
    },
  ],
  id: "skl_1",
  latestApprovedVersion: 3,
  latestVersion: 5,
  name: "Deploy checks",
  owner: { agentId: "agt_1", name: "Ops Bot" },
  pendingProposals: [4, 5],
};

const UNAPPROVED_SKILL: SkillInfo = {
  assignedTo: [],
  id: "skl_2",
  latestApprovedVersion: null,
  latestVersion: null,
  name: "Draft",
  owner: { agentId: null, name: "people" },
  pendingProposals: [],
};

const VERSION: SkillVersionInfo = {
  approvedAt: "2026-10-17T08:00:00.000Z",
  authorKind: "agent",
  createdAt: "2026-10-17T07:00:00.000Z",
  message: "Add the smoke test",
  number: 3,
  parent: 2,
  skillId: "skl_1",
  skillName: "Deploy checks",
  status: "approved",
};

const PROPOSED: SkillVersionInfo = {
  ...VERSION,
  approvedAt: null,
  message: "Retry the probe",
  number: 4,
  parent: 3,
  status: "proposed",
};

const DIFF: SkillDiffInfo = {
  added: ["scripts/probe.sh"],
  changed: ["SKILL.md"],
  patches: [
    { patch: "--- a/SKILL.md\n+++ b/SKILL.md\n-old\n+new", path: "SKILL.md" },
  ],
  removed: ["notes.txt"],
};

const SHOWN_LIST: SkillShown = {
  file: null,
  files: [
    { executable: false, path: "SKILL.md", size: 120 },
    { executable: true, path: "scripts/run.sh", size: 42 },
  ],
  version: VERSION,
};

/** Ports that answer what a test needs and reject any other call. */
const fakePorts = (overrides: Partial<McpPorts>): McpPorts =>
  ({
    exportSkill: uncalled("exportSkill"),
    listSkills: uncalled("listSkills"),
    skillDiff: uncalled("skillDiff"),
    skillLog: uncalled("skillLog"),
    skillShow: uncalled("skillShow"),
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
  registerTools(server, skillReadTools(ports));
  const { client, close } = await connectClient(server);
  try {
    return await client.callTool({ arguments: args, name });
  } finally {
    await close();
  }
};

const listTools = async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, skillReadTools(fakePorts({})));
  const { client, close } = await connectClient(server);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await close();
  }
};

describe("skill read tools: names and annotations", () => {
  test("registers the five read-only tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "export_skill",
        "list_skills",
        "skill_diff",
        "skill_log",
        "skill_show",
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("skill read tools: inputs and results", () => {
  test("list_skills returns the skills and shows the owner in the text", async () => {
    let calls = 0;
    const result = await callTool(
      fakePorts({
        listSkills: () => {
          calls += 1;
          return Promise.resolve([SKILL, UNAPPROVED_SKILL]);
        },
      }),
      "list_skills",
      {}
    );
    expect(calls).toBe(1);
    expect(result.structuredContent).toEqual({
      skills: [SKILL, UNAPPROVED_SKILL],
    });
    expect(textOf(result)).toBe(
      'skl_1 "Deploy checks" (owner: Ops Bot) latest approved: v3, latest: v5; pending proposals: v4, v5; agents: Ops Bot v3, Mailer v2 pinned\n' +
        'skl_2 "Draft" (owner: people) latest approved: none, latest: none; pending proposals: none; agents: none'
    );
  });

  test("list_skills says so when there are no skills", async () => {
    const result = await callTool(
      fakePorts({ listSkills: () => Promise.resolve([]) }),
      "list_skills",
      {}
    );
    expect(textOf(result)).toBe("No skills.");
  });

  test("skill_log passes the skill id and lists versions newest first", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        skillLog: (input) => {
          received = input;
          return Promise.resolve([VERSION, PROPOSED]);
        },
      }),
      "skill_log",
      { skillId: "skl_1" }
    );
    expect(received).toEqual({ skillId: "skl_1" });
    expect(result.structuredContent).toEqual({ versions: [VERSION, PROPOSED] });
    expect(textOf(result)).toBe(
      'v4 proposed by agent: "Retry the probe" (2026-10-17T07:00:00.000Z)\n' +
        'v3 approved by agent: "Add the smoke test" (2026-10-17T07:00:00.000Z)'
    );
  });

  test("skill_show without a path leaves path out of the port call", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        skillShow: (input) => {
          received = input;
          return Promise.resolve(SHOWN_LIST);
        },
      }),
      "skill_show",
      { skillId: "skl_1", version: 3 }
    );
    expect(received).toEqual({ skillId: "skl_1", version: 3 });
    expect(received).not.toHaveProperty("path");
    expect(result.structuredContent).toEqual({
      file: null,
      files: SHOWN_LIST.files,
      version: VERSION,
    });
    expect(textOf(result)).toBe(
      'Deploy checks v3 approved: "Add the smoke test"\n' +
        "SKILL.md (120 bytes)\n" +
        "scripts/run.sh (42 bytes, executable)"
    );
  });

  test("skill_show with a path returns the file content", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        skillShow: (input) => {
          received = input;
          return Promise.resolve({
            ...SHOWN_LIST,
            file: {
              content: "#!/bin/sh\necho ok\n",
              encoding: "utf8",
              path: "scripts/run.sh",
            },
          });
        },
      }),
      "skill_show",
      { path: "scripts/run.sh", skillId: "skl_1", version: 3 }
    );
    expect(received).toEqual({
      path: "scripts/run.sh",
      skillId: "skl_1",
      version: 3,
    });
    expect(textOf(result)).toContain(
      "--- scripts/run.sh ---\n#!/bin/sh\necho ok\n"
    );
  });

  test("skill_show labels a binary file as base64", async () => {
    const result = await callTool(
      fakePorts({
        skillShow: () =>
          Promise.resolve({
            ...SHOWN_LIST,
            file: {
              content: "iVBORw0K",
              encoding: "base64",
              path: "logo.png",
            },
          }),
      }),
      "skill_show",
      { path: "logo.png", skillId: "skl_1", version: 3 }
    );
    expect(textOf(result)).toContain(
      "--- logo.png (binary, base64) ---\niVBORw0K"
    );
  });

  test("skill_diff passes both versions and lists the changes with their patches", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        skillDiff: (input) => {
          received = input;
          return Promise.resolve(DIFF);
        },
      }),
      "skill_diff",
      { from: 3, skillId: "skl_1", to: 4 }
    );
    expect(received).toEqual({ from: 3, skillId: "skl_1", to: 4 });
    expect(result.structuredContent).toEqual({
      added: DIFF.added,
      changed: DIFF.changed,
      patches: DIFF.patches,
      removed: DIFF.removed,
    });
    expect(textOf(result)).toBe(
      "added: scripts/probe.sh\n" +
        "removed: notes.txt\n" +
        "changed: SKILL.md\n\n" +
        "--- a/SKILL.md\n+++ b/SKILL.md\n-old\n+new"
    );
  });

  test("skill_diff says No changes. when nothing differs", async () => {
    const result = await callTool(
      fakePorts({
        skillDiff: () =>
          Promise.resolve({ added: [], changed: [], patches: [], removed: [] }),
      }),
      "skill_diff",
      { from: 3, skillId: "skl_1", to: 4 }
    );
    expect(textOf(result)).toBe("No changes.");
  });

  test("export_skill returns the archive and the base64 in the text", async () => {
    let received: unknown;
    const result = await callTool(
      fakePorts({
        exportSkill: (input) => {
          received = input;
          return Promise.resolve({
            archiveBase64: "UEsDBA==",
            filename: "deploy-checks-v3.skill",
          });
        },
      }),
      "export_skill",
      { skillId: "skl_1", version: 3 }
    );
    expect(received).toEqual({ skillId: "skl_1", version: 3 });
    expect(result.structuredContent).toEqual({
      archiveBase64: "UEsDBA==",
      filename: "deploy-checks-v3.skill",
    });
    expect(textOf(result)).toBe(
      "Exported deploy-checks-v3.skill. Base64 of the .skill archive:\nUEsDBA=="
    );
  });
});

describe("skill read tools: failures", () => {
  test("a port's not_found ToolError comes back as an error result with its code", async () => {
    const result = await callTool(
      fakePorts({
        skillShow: () =>
          Promise.reject(
            new ToolError("not_found", "No version 9 of this skill.")
          ),
      }),
      "skill_show",
      { skillId: "skl_1", version: 9 }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "not_found",
      message: "No version 9 of this skill.",
    });
  });

  test("a version below 1 is refused before the port runs", async () => {
    const result = await callTool(fakePorts({}), "skill_diff", {
      from: 0,
      skillId: "skl_1",
      to: 2,
    });
    expect(result.isError).toBe(true);
  });
});
