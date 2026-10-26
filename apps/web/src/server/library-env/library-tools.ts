// Pi's own `read`, `write` and `edit` tools for a cloud run, working on the
// workspace library through `createLibraryEnv`. `bash` is left out: the
// environment has no shell, and the library `bash` tool over MCP covers it.
import type { Extension } from "@earendil-works/pi-durable";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { workspaceInstructions } from "@repo/protocol/attachments";
import { agentHomePath } from "@repo/services/library/home";
import { LIBRARY_MOUNT } from "../library-bash/run.ts";

export const LIBRARY_TOOLS_EXTENSION = "hm-library-tools";

const SECTION_KEY = "library-files";

/**
 * The files section names the agent's home in the library. `slugOf` is read
 * when the prompt renders, because the extension is installed before the
 * agent's slug is known. Without a slug the section names the library root.
 */
const homeFor = async (
  slugOf: () => Promise<string | undefined>
): Promise<string> => {
  const slug = await slugOf();
  return slug === undefined
    ? LIBRARY_MOUNT
    : `${LIBRARY_MOUNT}/${agentHomePath(slug)}`;
};

/**
 * The run's task folder, as a library path, is read when the prompt renders.
 * Without an answer the section names no task folder.
 */
const taskFolderLine = async (
  taskFolderOf?: () => Promise<string | undefined>
): Promise<string | undefined> => {
  const path = await taskFolderOf?.();
  return path === undefined ? undefined : `${LIBRARY_MOUNT}/${path}`;
};

/**
 * A read changes nothing, so it may run again after a restart. A write and an edit may not.
 * `slugOf` and `taskFolderOf` are read when the prompt renders.
 */
export const libraryToolsExtension = (
  slugOf: () => Promise<string | undefined>,
  taskFolderOf?: () => Promise<string | undefined>
): Extension => ({
  name: LIBRARY_TOOLS_EXTENSION,
  sections: [
    {
      key: SECTION_KEY,
      render: async () =>
        workspaceInstructions({
          attachments: false,
          home: await homeFor(slugOf),
          homeIsLocal: true,
          library: LIBRARY_MOUNT,
          runScript: true,
          scratch: { lasts: "call", path: null },
          taskFolder: await taskFolderLine(taskFolderOf),
        }),
    },
  ],
  tools: [
    { ...createReadTool(), replay: "safe" },
    createWriteTool(),
    createEditTool(),
  ],
});
