import { z } from "zod";
import type {
  McpPorts,
  SkillAssignee,
  SkillFileContent,
  SkillFileInfo,
  SkillInfo,
  SkillVersionInfo,
} from "../ports";
import { defineTool, READ_ONLY, type ToolDefinition } from "./define";

const skillId = z
  .string()
  .min(1)
  .max(200)
  .describe("A skill id, as list_skills returns.");

const version = z
  .number()
  .int()
  .min(1)
  .max(1_000_000)
  .describe("A version number of the skill, such as 3 for v3.");

const path = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "A file path inside the version, such as scripts/run.sh. Leave it out to list the files only."
  );

const versionLabel = (number: number | null): string =>
  number === null ? "none" : `v${number}`;

const agentLabel = (agent: SkillAssignee): string =>
  `${agent.name} v${agent.version}${agent.pinned ? " pinned" : ""}`;

const skillLine = (skill: SkillInfo): string => {
  const proposals =
    skill.pendingProposals.map((number) => `v${number}`).join(", ") || "none";
  const agents = skill.assignedTo.map(agentLabel).join(", ") || "none";
  return `${skill.id} "${skill.name}" (owner: ${skill.owner.name}) latest approved: ${versionLabel(skill.latestApprovedVersion)}, latest: ${versionLabel(skill.latestVersion)}; pending proposals: ${proposals}; agents: ${agents}`;
};

const versionLine = (entry: SkillVersionInfo): string =>
  `v${entry.number} ${entry.status} by ${entry.authorKind}: "${entry.message}" (${entry.createdAt})`;

const fileLine = (file: SkillFileInfo): string =>
  `${file.path} (${file.size} bytes${file.executable ? ", executable" : ""})`;

const contentBlock = (file: SkillFileContent): string => {
  const header =
    file.encoding === "utf8"
      ? `--- ${file.path} ---`
      : `--- ${file.path} (binary, base64) ---`;
  return `${header}\n${file.content}`;
};

export const skillReadTools = (ports: McpPorts): ToolDefinition[] => [
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists the skills the caller can see, with the owner, the latest approved version, the latest version, the proposals waiting for a person to approve and the agents that carry each skill. The ids are used by the other skill tools. A skill name is unique only per owner, so the owner is shown next to it.",
    inputSchema: z.strictObject({}),
    name: "list_skills",
    run: async () => {
      const skills = await ports.listSkills();
      return {
        data: { skills },
        text: skills.map(skillLine).join("\n") || "No skills.",
      };
    },
    title: "List skills",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Lists a skill's versions, newest first, with status, author and message. Use the version numbers with skill_show, skill_diff and export_skill.",
    inputSchema: z.strictObject({ skillId }),
    name: "skill_log",
    run: async (input) => {
      const versions = await ports.skillLog(input);
      const newestFirst = [...versions].sort((a, b) => b.number - a.number);
      return {
        data: { versions },
        text: newestFirst.map(versionLine).join("\n") || "No versions.",
      };
    },
    title: "Show skill log",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Shows a version of a skill: its file tree, and the content of one file when a path is given. Pass the version number to see a version. An agent can show its own proposed versions by number to test them.",
    inputSchema: z.strictObject({
      path: path.optional(),
      skillId,
      version,
    }),
    name: "skill_show",
    run: async (input) => {
      const shown = await ports.skillShow(
        input.path === undefined
          ? { skillId: input.skillId, version: input.version }
          : input
      );
      const lines = [
        `${shown.version.skillName} v${shown.version.number} ${shown.version.status}: "${shown.version.message}"`,
        ...shown.files.map(fileLine),
      ];
      if (shown.file) {
        lines.push("", contentBlock(shown.file));
      }
      return {
        data: {
          file: shown.file,
          files: shown.files,
          version: shown.version,
        },
        text: lines.join("\n"),
      };
    },
    title: "Show skill version",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Compares two versions of a skill. It lists the files added, removed and changed, then the unified diff of each text file that differs.",
    inputSchema: z.strictObject({
      from: version,
      skillId,
      to: version,
    }),
    name: "skill_diff",
    run: async (input) => {
      const diff = await ports.skillDiff(input);
      const summary: string[] = [];
      if (diff.added.length > 0) {
        summary.push(`added: ${diff.added.join(", ")}`);
      }
      if (diff.removed.length > 0) {
        summary.push(`removed: ${diff.removed.join(", ")}`);
      }
      if (diff.changed.length > 0) {
        summary.push(`changed: ${diff.changed.join(", ")}`);
      }
      const text = [
        summary.join("\n") || "No changes.",
        ...diff.patches.map((patch) => patch.patch),
      ].join("\n\n");
      return {
        data: {
          added: diff.added,
          changed: diff.changed,
          patches: diff.patches,
          removed: diff.removed,
        },
        text,
      };
    },
    title: "Diff skill versions",
  }),
  defineTool({
    annotations: READ_ONLY,
    description:
      "Returns a version of a skill as a .skill archive (a zip with one folder named after the skill), base64 encoded. import_skill takes the same text.",
    inputSchema: z.strictObject({ skillId, version }),
    name: "export_skill",
    run: async (input) => {
      const archive = await ports.exportSkill(input);
      return {
        data: {
          archiveBase64: archive.archiveBase64,
          filename: archive.filename,
        },
        text: `Exported ${archive.filename}. Base64 of the .skill archive:\n${archive.archiveBase64}`,
      };
    },
    title: "Export skill",
  }),
];
