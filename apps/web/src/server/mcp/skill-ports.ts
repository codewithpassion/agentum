// The skill tools' view of the skills store, bound to the caller's principal
// like `createMcpPorts`. Each member is a thin call on `services.skillsStore`,
// so the store's `authorize` and its rules apply as they do in the UI.
import type {
  AgentInfo,
  McpPorts,
  SkillAssignee,
  SkillAssignment,
  SkillFileContent,
  SkillFileWrite,
  SkillInfo,
  SkillShown,
  SkillVersionInfo,
} from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import type {
  AssignmentRecord,
  FileWrite,
  ShownVersion,
  VersionRecord,
} from "@repo/services/skills-store/records";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { guarded } from "./guarded.ts";

export type SkillPorts = Pick<
  McpPorts,
  | "approveSkillVersion"
  | "assignSkill"
  | "commitSkill"
  | "createSkill"
  | "exportSkill"
  | "importSkill"
  | "listSkills"
  | "pinSkill"
  | "rejectSkillVersion"
  | "revertSkill"
  | "skillDiff"
  | "skillLog"
  | "skillShow"
  | "unassignSkill"
>;

const toVersionInfo = (
  version: VersionRecord,
  skillName: string
): SkillVersionInfo => ({
  approvedAt: version.approvedAt,
  authorKind: version.author.kind,
  createdAt: version.createdAt,
  message: version.message,
  number: version.number,
  parent: version.parent,
  skillId: version.skillId,
  skillName,
  status: version.status,
});

const toAssignment = (record: AssignmentRecord): SkillAssignment => ({
  agentId: record.agentId,
  pinnedVersion: record.pinnedVersion,
  skillId: record.skillId,
});

const toFileWrite = (file: SkillFileWrite): FileWrite => ({
  content:
    file.encoding === "base64" ? base64ToBytes(file.content) : file.content,
  path: file.path,
  ...(file.executable === undefined ? {} : { executable: file.executable }),
});

/** UTF-8 text when the bytes are valid UTF-8, else base64. */
const toFileContent = (path: string, bytes: Uint8Array): SkillFileContent => {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { content, encoding: "utf8", path };
  } catch {
    return { content: bytesToBase64(bytes), encoding: "base64", path };
  }
};

/** One file of a shown version, with its content. A path the version lacks is not_found. */
const fileContentAt = (shown: ShownVersion, path: string): SkillFileContent => {
  const found = shown.files.find((file) => file.path === path);
  if (!found) {
    throw new ToolError(
      "not_found",
      `No file "${path}" in version ${shown.version.number}.`
    );
  }
  if (found.content === undefined) {
    throw new Error(`The store returned no content for "${path}".`);
  }
  return toFileContent(path, found.content);
};

export const createSkillPorts = ({
  principal,
  services,
  findAgent,
}: {
  principal: Principal;
  services: Pick<Services, "agents" | "skillsStore">;
  findAgent: (reference: string) => Promise<AgentInfo>;
}): SkillPorts => {
  const { agents, skillsStore } = services;

  /** The name of a skill the caller can see, or its id when it is not listed. */
  const skillNameOf = async (skillId: string): Promise<string> => {
    const skills = await skillsStore.list(principal);
    return skills.find((skill) => skill.id === skillId)?.name ?? skillId;
  };

  return {
    approveSkillVersion: ({ skillId, version }) =>
      guarded(async () =>
        toVersionInfo(
          await skillsStore.approve(principal, { skillId, version }),
          await skillNameOf(skillId)
        )
      ),

    assignSkill: ({ agent, skillId }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        return toAssignment(
          await skillsStore.assign(principal, { agentId: target.id, skillId })
        );
      }),

    commitSkill: ({ baseVersion, deletes, message, skillId, writes }) =>
      guarded(async () =>
        toVersionInfo(
          await skillsStore.commit(principal, {
            baseVersion,
            deletes: deletes.map((path) => ({ path })),
            message,
            skillId,
            writes: writes.map(toFileWrite),
          }),
          await skillNameOf(skillId)
        )
      ),

    createSkill: ({ files, message, name }) =>
      guarded(async () => {
        const { skill, version } = await skillsStore.create(principal, {
          files: files.map(toFileWrite),
          message,
          name,
        });
        return toVersionInfo(version, skill.name);
      }),

    exportSkill: ({ skillId, version }) =>
      guarded(async () => {
        const archive = await skillsStore.exportSkillArchive(principal, {
          skillId,
          version,
        });
        return {
          archiveBase64: bytesToBase64(archive.bytes),
          filename: archive.filename,
        };
      }),

    importSkill: ({ archiveBase64 }) =>
      guarded(async () => {
        const imported = await skillsStore.importSkillArchive(
          principal,
          base64ToBytes(archiveBase64)
        );
        return {
          created: imported.created,
          name: imported.name,
          version: toVersionInfo(imported.version, imported.name),
        };
      }),

    listSkills: () =>
      guarded(async () => {
        const [skills, agentList] = await Promise.all([
          skillsStore.list(principal),
          agents.list(principal),
        ]);
        const agentById = new Map(agentList.map((agent) => [agent.id, agent]));
        const carriers: string[] =
          principal.kind === "run"
            ? [principal.agentId]
            : agentList.map((agent) => agent.id);
        const assignees = new Map<string, SkillAssignee[]>();
        for (const agentId of carriers) {
          const agent = agentById.get(agentId);
          for (const resolved of await skillsStore.forAgent(
            principal,
            agentId
          )) {
            const entry: SkillAssignee = {
              agentId,
              name: agent?.name ?? agentId,
              pinned: resolved.pinned,
              slug: agent?.slug ?? agentId,
              version: resolved.version,
            };
            assignees.set(resolved.skillId, [
              ...(assignees.get(resolved.skillId) ?? []),
              entry,
            ]);
          }
        }
        return Promise.all(
          skills.map(async (skill): Promise<SkillInfo> => {
            const versions = await skillsStore.log(principal, {
              skillId: skill.id,
            });
            const pendingProposals = versions
              .filter((version) => version.status === "proposed")
              .map((version) => version.number)
              .sort((a, b) => a - b);
            return {
              assignedTo: assignees.get(skill.id) ?? [],
              id: skill.id,
              latestApprovedVersion: skill.latestApprovedVersion,
              latestVersion: skill.latestVersion,
              name: skill.name,
              owner: {
                agentId: skill.ownerAgentId,
                name:
                  skill.ownerAgentId === null
                    ? "people"
                    : (agentById.get(skill.ownerAgentId)?.name ??
                      skill.ownerAgentId),
              },
              pendingProposals,
            };
          })
        );
      }),

    pinSkill: ({ agent, skillId, version }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        return toAssignment(
          await skillsStore.pin(principal, {
            agentId: target.id,
            skillId,
            version,
          })
        );
      }),

    rejectSkillVersion: ({ skillId, version }) =>
      guarded(async () =>
        toVersionInfo(
          await skillsStore.reject(principal, { skillId, version }),
          await skillNameOf(skillId)
        )
      ),

    revertSkill: ({ message, skillId, toVersion }) =>
      guarded(async () =>
        toVersionInfo(
          await skillsStore.revert(principal, {
            skillId,
            toVersion,
            ...(message === undefined ? {} : { message }),
          }),
          await skillNameOf(skillId)
        )
      ),

    skillDiff: ({ from, skillId, to }) =>
      guarded(() => skillsStore.diff(principal, { from, skillId, to })),

    skillLog: ({ skillId }) =>
      guarded(async () => {
        const [versions, skillName] = await Promise.all([
          skillsStore.log(principal, { skillId }),
          skillNameOf(skillId),
        ]);
        return versions.map((version) => toVersionInfo(version, skillName));
      }),

    skillShow: ({ path, skillId, version }) =>
      guarded(async (): Promise<SkillShown> => {
        const shown = await skillsStore.show(principal, {
          skillId,
          version,
          withContents: path !== undefined,
        });
        const file = path === undefined ? null : fileContentAt(shown, path);
        return {
          file,
          files: shown.files.map((entry) => ({
            executable: entry.executable,
            path: entry.path,
            size: entry.size,
          })),
          version: toVersionInfo(shown.version, await skillNameOf(skillId)),
        };
      }),

    unassignSkill: ({ agent, skillId }) =>
      guarded(async () => {
        const target = await findAgent(agent);
        await skillsStore.unassign(principal, {
          agentId: target.id,
          skillId,
        });
      }),
  };
};
