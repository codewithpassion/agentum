import { z } from "zod";
import type { McpPorts, SkillVersionInfo } from "../ports";
import {
  defineTool,
  type ToolDefinition,
  WRITE_CREATE,
  WRITE_DELETE,
  WRITE_UPDATE,
} from "./define";

const skillId = z
  .string()
  .min(1)
  .max(200)
  .describe("A skill id, as list_skills returns.");

const agent = z
  .string()
  .min(1)
  .max(200)
  .describe("An agent id or slug, as list_agents returns.");

const version = z
  .int()
  .min(1)
  .describe("A version number, as skill_log returns.");

const message = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("One line on what changed and why.");

const fileWrite = z.strictObject({
  content: z
    .string()
    .max(8_000_000)
    .describe("The file's content, as text or as base64 per encoding."),
  encoding: z
    .enum(["utf8", "base64"])
    .default("utf8")
    .describe("utf8 for text, base64 for a binary file."),
  executable: z
    .boolean()
    .optional()
    .describe("true to mark the file executable."),
  path: z
    .string()
    .min(1)
    .max(512)
    .describe("The file's path inside the skill, such as scripts/run.ts."),
});

const PROPOSED_NOTE = (number: number): string =>
  `Version ${number} is proposed. It stays unused until a person approves it in the Harbourmaster UI. To test it, read it with skill_show (version ${number}) and run its scripts with run_skill_script, passing version ${number}.`;

/** Says what a version is, and that a proposal waits for a person. */
const versionLine = (verb: string, created: SkillVersionInfo): string => {
  const head = `${verb} version ${created.number} of "${created.skillName}" (${created.skillId}), status ${created.status}.`;
  return created.status === "proposed"
    ? `${head} ${PROPOSED_NOTE(created.number)}`
    : head;
};

export const skillWriteTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Creates a skill: a named set of files that agents can carry and run. When a run creates it, the new version is a proposal that waits for a person to approve it in the Harbourmaster UI.",
    inputSchema: z.strictObject({
      files: z
        .array(fileWrite)
        .min(1)
        .max(200)
        .describe("The files of the first version. At least one."),
      message,
      name: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("The skill's name, unique among the skills of its owner."),
    }),
    name: "create_skill",
    run: async (input) => {
      const created = await ports.createSkill(input);
      return {
        data: { version: created },
        text: versionLine("Created", created),
      };
    },
    title: "Create skill",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Commits a new version of a skill. A commit is a whole set of file changes (writes and deletes) on top of a base version, and a stale base is refused, so read the latest with skill_log and redo the change on top of it. A run can commit only to skills its agent owns, and its commit is a proposal.",
    inputSchema: z.strictObject({
      baseVersion: version.describe(
        "The version this commit is made on, normally the latest one."
      ),
      deletes: z
        .array(z.string().min(1).max(512))
        .max(200)
        .default([])
        .describe("Paths of files to remove from the base version."),
      message,
      skillId,
      writes: z
        .array(fileWrite)
        .max(200)
        .default([])
        .describe("Files to add or replace on top of the base version."),
    }),
    name: "commit_skill",
    run: async (input) => {
      const committed = await ports.commitSkill(input);
      return {
        data: { version: committed },
        text: versionLine("Committed", committed),
      };
    },
    title: "Commit skill version",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Reverts a skill by making a new version with the files of an older version, on top of the latest version. The older versions stay as they are.",
    inputSchema: z.strictObject({
      message: message
        .optional()
        .describe("One line on why the skill is reverted."),
      skillId,
      toVersion: version.describe("The older version whose files to restore."),
    }),
    name: "revert_skill",
    run: async (input) => {
      const reverted = await ports.revertSkill(input);
      return {
        data: { version: reverted },
        text: versionLine("Reverted", reverted),
      };
    },
    title: "Revert skill",
  }),
  defineTool({
    annotations: WRITE_CREATE,
    description:
      "Imports a `.skill` archive, given as base64, which export_skill returns. It makes a new skill, or a new version holding exactly the archive's files when the caller already owns a skill of that name.",
    inputSchema: z.strictObject({
      archiveBase64: z
        .string()
        .min(1)
        .max(14_000_000)
        .describe("The `.skill` archive, base64 encoded."),
    }),
    name: "import_skill",
    run: async (input) => {
      const imported = await ports.importSkill(input);
      return {
        data: {
          created: imported.created,
          name: imported.name,
          version: imported.version,
        },
        text: versionLine("Imported", imported.version),
      };
    },
    title: "Import skill",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Approves a proposed version of a skill, so agents can use it. People only: a run is refused. A proposal can only be approved while its base is the latest approved version.",
    inputSchema: z.strictObject({ skillId, version }),
    name: "approve_skill_version",
    run: async (input) => {
      const approved = await ports.approveSkillVersion(input);
      return {
        data: { version: approved },
        text: `Approved version ${approved.number} of "${approved.skillName}" (${approved.skillId}).`,
      };
    },
    title: "Approve skill version",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Rejects a proposed version of a skill. It also rejects the proposals built on it. People only: a run is refused.",
    inputSchema: z.strictObject({ skillId, version }),
    name: "reject_skill_version",
    run: async (input) => {
      const rejected = await ports.rejectSkillVersion(input);
      return {
        data: { version: rejected },
        text: `Rejected version ${rejected.number} of "${rejected.skillName}" (${rejected.skillId}).`,
      };
    },
    title: "Reject skill version",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Gives an agent a skill. The agent then uses the latest approved version. An agent carries one skill per name. People only: a run is refused.",
    inputSchema: z.strictObject({ agent, skillId }),
    name: "assign_skill",
    run: async (input) => {
      const assignment = await ports.assignSkill(input);
      return {
        data: { assignment },
        text: `Assigned "${assignment.skillId}" to ${input.agent}.`,
      };
    },
    title: "Assign skill",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Removes a skill from an agent, so the agent no longer carries it. People only: a run is refused.",
    inputSchema: z.strictObject({ agent, skillId }),
    name: "unassign_skill",
    run: async (input) => {
      await ports.unassignSkill(input);
      return {
        data: {
          unassigned: { agent: input.agent, skillId: input.skillId },
        },
        text: `Unassigned "${input.skillId}" from ${input.agent}.`,
      };
    },
    title: "Unassign skill",
  }),
  defineTool({
    annotations: WRITE_DELETE,
    description:
      "Deletes a skill with all its versions, files and assignments, so no agent carries it any more. People only: a run is refused. Also refused while a run of an agent that carries the skill is active.",
    inputSchema: z.strictObject({ skillId }),
    name: "delete_skill",
    run: async (input) => {
      await ports.deleteSkill(input);
      return {
        data: { deleted: { skillId: input.skillId } },
        text: `Deleted "${input.skillId}" with all its versions, files and assignments.`,
      };
    },
    title: "Delete skill",
  }),
  defineTool({
    annotations: WRITE_UPDATE,
    description:
      "Pins an agent to one approved version of a skill. Pass null to follow the latest approved version again. People only: a run is refused.",
    inputSchema: z.strictObject({
      agent,
      skillId,
      version: version
        .nullable()
        .describe(
          "The approved version to pin to, or null to follow the latest approved version."
        ),
    }),
    name: "pin_skill",
    run: async (input) => {
      const assignment = await ports.pinSkill(input);
      const text =
        assignment.pinnedVersion === null
          ? `Unpinned "${assignment.skillId}" for ${input.agent}: the agent follows the latest approved version.`
          : `Pinned "${assignment.skillId}" for ${input.agent} to version ${assignment.pinnedVersion}.`;
      return { data: { assignment }, text };
    },
    title: "Pin skill version",
  }),
];
