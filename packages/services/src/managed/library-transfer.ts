/**
 * Library transfer for a managed sandbox. A file the agent makes on its disk
 * (a PDF, an image, a large CSV) cannot reach the library through a tool call
 * without the model typing its bytes, and library files the model has not
 * pasted in are invisible to the sandbox's own tools. A bundled helper moves
 * them once in each direction over `/api/session/library/*`: `pull` at the
 * start of a run, `push` before it ends.
 *
 * Three pieces, all built here:
 * - the credential: the session token as one more environment variable
 *   credential, limited to the Worker's host (`HM_LIBRARY_TOKEN`);
 * - a built-in skill that carries the helper script, uploaded through the same
 *   Skills API path as any skill of the agent;
 * - the text that tells the agent when to run it.
 */

import { hashToken } from "../crypto.ts";
import { TRAILING_SLASHES } from "../shared.ts";
import type { FileRecord, ResolvedSkill } from "../skills-store/records.ts";
import { MAX_SKILLS, type SkillsSource } from "./skills-sync.ts";

/** The environment variable that holds the session token, where the agent can use it. */
export const LIBRARY_TOKEN_ENV = "HM_LIBRARY_TOKEN";

/** The skill's name, and so its folder `/workspace/skills/library-transfer/`. */
export const LIBRARY_SKILL_NAME = "library-transfer";

/** The route prefix the helper talks to, under the Worker's origin. */
export const SESSION_LIBRARY_PATH = "/api/session/library";

/** Where the helper keeps the library copy in the sandbox. */
export const SANDBOX_LIBRARY_DIR = "/workspace/library";

const HELPER_PATH = "scripts/library.js";
const HELPER_COMMAND = `bun /workspace/skills/${LIBRARY_SKILL_NAME}/${HELPER_PATH}`;
const SKILL_ID_PREFIX = "builtin-library-transfer-";
const VERSION_HEX_DIGITS = 7;
const HEX_RADIX = 16;
const ENCODER = new TextEncoder();

const skillText = (): string => `---
name: ${LIBRARY_SKILL_NAME}
description: Copy files between the workspace library and this sandbox's disk, for files too big or too many to pass through tool calls.
---

# Library transfer

The workspace library is not on your disk. The library tools read and write text well. Use this skill when you need to move whole files: a library folder you want python, bun or grep to work on, or a file you made here (a PDF, an image, a large CSV) that must reach the library.

Run the helper with bun. The platform address is in your instructions as the \`--url\` value.

\`\`\`
${HELPER_COMMAND} pull <library path>... --url <address>
${HELPER_COMMAND} push [<library path>...] --url <address>
\`\`\`

\`pull\` copies each library file or folder into ${SANDBOX_LIBRARY_DIR}/<library path>. A file you edited here and did not push is kept, not overwritten.

\`push\` sends your changes under the given library paths back: new and changed files are written, and a file you deleted here is deleted in the library. With no path, it sends everything under ${SANDBOX_LIBRARY_DIR}. A file the library changed meanwhile is not overwritten. Your copy is saved next to it as <path>.conflict-<run>, and the helper says so.

The helper prints what it moved, skipped or could not move, and exits with 1 when any file failed. Files over 10 MB are skipped. Never print or write down $${LIBRARY_TOKEN_ENV}.
`;

/** The agent-facing text, appended to the system prompt of an agent that has the skill. */
export const libraryTransferGuidance = ({
  base,
  slug,
}: {
  base: string;
  slug: string;
}): string => {
  const url = base.replace(TRAILING_SLASHES, "");
  return `# Moving files between the library and your disk

Your sandbox disk is separate from the workspace library. For a file the library tools cannot carry well, use the ${LIBRARY_SKILL_NAME} skill:
- Before you work on library files with python, bun or grep over many files, run \`${HELPER_COMMAND} pull agents/${slug} --url ${url}\` (or the folder you need). The files appear under ${SANDBOX_LIBRARY_DIR}/.
- Before you finish a run that made files on your disk for the user, put them in the task folder named in the message, under ${SANDBOX_LIBRARY_DIR}/<that folder>/, and run \`${HELPER_COMMAND} push <that folder> --url ${url}\`. A file left only on your disk is lost.
Small text files are simpler to read and write with the library tools. The helper authenticates with $${LIBRARY_TOKEN_ENV}, which is already set.`;
};

const digestOf = async (
  files: readonly { content: Uint8Array; path: string }[]
): Promise<string> =>
  hashToken(
    JSON.stringify(
      files.map((file) => [file.path, new TextDecoder().decode(file.content)])
    )
  );

/**
 * The agent's skills with the library transfer skill added. The helper's
 * content decides the version, so a new helper uploads a new version by
 * itself. The skill id carries the workspace, because each workspace uploads
 * to Anthropic with its own key. An agent at the skill limit gets none.
 */
export const withLibraryTransferSkill = async (
  inner: SkillsSource,
  { helper, workspaceId }: { helper: string; workspaceId: string }
): Promise<SkillsSource> => {
  const files = [
    { content: ENCODER.encode(skillText()), path: "SKILL.md" },
    { content: ENCODER.encode(helper), path: HELPER_PATH },
  ];
  const skillId = `${SKILL_ID_PREFIX}${workspaceId}`;
  const digest = await digestOf(files);
  const version = Number.parseInt(
    digest.slice(0, VERSION_HEX_DIGITS),
    HEX_RADIX
  );
  const records: FileRecord[] = await Promise.all(
    files.map(async (file) => ({
      executable: false,
      hash: await hashToken(new TextDecoder().decode(file.content)),
      path: file.path,
      size: file.content.byteLength,
    }))
  );
  const builtin: ResolvedSkill = {
    files: records,
    name: LIBRARY_SKILL_NAME,
    pinned: false,
    skillId,
    version,
  };
  return {
    files: (id, requested) =>
      id === skillId && requested === version
        ? Promise.resolve(files)
        : inner.files(id, requested),
    list: async () => {
      const own = await inner.list();
      return own.length >= MAX_SKILLS ||
        own.some((skill) => skill.name === LIBRARY_SKILL_NAME)
        ? own
        : [...own, builtin];
    },
  };
};
