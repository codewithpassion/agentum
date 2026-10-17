import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { readSkillMeta } from "@repo/services/library/skill-file";

export const SKILLS_EXTENSION = "hm-skills";

const SECTION_KEY = "skills";
const ACTIVATE_TOOL = "activate_skill";
const READ_TOOL = "read_skill_resource";
const SKILL_FILE = "SKILL.md";
const CATALOG_HEADER =
  "Available skills. Use activate_skill to load one before you use it:";
const FILES_SEPARATOR = ", ";
const NO_FILES = "none";

const decoder = new TextDecoder();

/** One file the platform lists. `executable` is true when the file is flagged to run. */
export interface SkillsListing {
  executable?: boolean;
  path: string;
}

/** The platform's skills for a run, as the services give them. `list` returns every file path (relative, starting with the skill folder, e.g. "shout/SKILL.md", "shout/notes/a.md"); `read` returns one file's bytes by that path. */
export interface SkillsPort {
  list: () => Promise<readonly SkillsListing[]>;
  read: (path: string) => Promise<Uint8Array>;
}

/** What the prompt catalog needs. `name` equals the folder. `files` are the skill's other files, as listed paths. `executable` lists the paths flagged to run, and is set only when there is one. */
export interface SkillSummary {
  description: string;
  executable?: string[];
  files: string[];
  name: string;
}

const folderOf = (path: string): string => path.split("/")[0] ?? "";

const groupByFolder = (
  listed: readonly SkillsListing[]
): Map<string, SkillsListing[]> => {
  const groups = new Map<string, SkillsListing[]>();
  for (const entry of listed) {
    const folder = folderOf(entry.path);
    const group = groups.get(folder) ?? [];
    group.push(entry);
    groups.set(folder, group);
  }
  return groups;
};

const readText = async (port: SkillsPort, path: string): Promise<string> =>
  decoder.decode(await port.read(path));

/** The skill in `folder`, or undefined when it has no readable SKILL.md with valid frontmatter. */
const loadSkill = async (
  port: SkillsPort,
  folder: string,
  listed: readonly SkillsListing[]
): Promise<SkillSummary | undefined> => {
  const skillPath = `${folder}/${SKILL_FILE}`;
  const paths = listed.map((entry) => entry.path);
  if (!paths.includes(skillPath)) {
    return;
  }
  let text: string;
  try {
    text = await readText(port, skillPath);
  } catch {
    return;
  }
  const result = readSkillMeta(text, folder);
  if ("error" in result) {
    return;
  }
  const executable = listed
    .filter((entry) => entry.executable === true)
    .map((entry) => entry.path);
  return {
    description: result.meta.description,
    ...(executable.length > 0 ? { executable } : {}),
    files: paths.filter((path) => path !== skillPath),
    name: folder,
  };
};

const byName = (a: SkillSummary, b: SkillSummary): number => {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
};

/** Every valid skill in the port, sorted by name. Folders that fail to load are skipped. */
export const loadSkills = async (port: SkillsPort): Promise<SkillSummary[]> => {
  const listed = await port.list();
  const groups = groupByFolder(listed);
  const loaded = await Promise.all(
    [...groups].map(([folder, entries]) => loadSkill(port, folder, entries))
  );
  return loaded
    .filter((skill): skill is SkillSummary => skill !== undefined)
    .sort(byName);
};

const textResult = (text: string, isError = false): ToolExecutionResult => ({
  isError,
  output: [{ text, type: "text" }],
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The catalog section and the two tools. With no skills, the extension adds nothing. */
export const skillsExtension = (
  skills: readonly SkillSummary[],
  port: SkillsPort
): Extension => {
  if (skills.length === 0) {
    return { name: SKILLS_EXTENSION };
  }
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const catalog = [
    CATALOG_HEADER,
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");

  const activate = defineTool({
    description:
      "Loads a skill. Returns its full SKILL.md text, then the paths of its other files. Read the other files as text with read_skill_resource. Run a TypeScript or JavaScript script of the skill with run_skill_script, do not read it and work out its output yourself.",
    execute: async (args) => {
      const skill = skillsByName.get(args.name);
      if (skill === undefined) {
        return textResult(`Skill not found: ${args.name}`, true);
      }
      try {
        const text = await readText(port, `${skill.name}/${SKILL_FILE}`);
        const files = skill.files.join(FILES_SEPARATOR) || NO_FILES;
        return textResult(`${text.trimEnd()}\n\nFiles: ${files}`);
      } catch (error) {
        return textResult(errorText(error), true);
      }
    },
    name: ACTIVATE_TOOL,
    parameters: Type.Object({
      name: Type.Union(skills.map((skill) => Type.Literal(skill.name))),
    }),
    replay: "safe",
  });

  const read = defineTool({
    description:
      "Reads one file bundled with a skill, by the path that activate_skill lists. The file is returned as UTF-8 text. To run a script, use run_skill_script.",
    execute: async (args) => {
      try {
        return textResult(await readText(port, args.path));
      } catch (error) {
        return textResult(errorText(error), true);
      }
    },
    name: READ_TOOL,
    parameters: Type.Object({ path: Type.String() }),
    replay: "safe",
  });

  return {
    name: SKILLS_EXTENSION,
    sections: [{ key: SECTION_KEY, render: () => catalog }],
    tools: [activate, read],
  };
};
