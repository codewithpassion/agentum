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

/** A read changes nothing, so it may run again after a restart. A write and an edit may not. */
export const libraryToolsExtension = (
  slugOf: () => Promise<string | undefined>
): Extension => ({
  name: LIBRARY_TOOLS_EXTENSION,
  sections: [
    {
      key: SECTION_KEY,
      render: async () =>
        workspaceInstructions({
          home: await homeFor(slugOf),
          homeIsLocal: true,
          library: LIBRARY_MOUNT,
          runScript: true,
          scratch: { lasts: "call", path: null },
        }),
    },
  ],
  tools: [
    { ...createReadTool(), replay: "safe" },
    createWriteTool(),
    createEditTool(),
  ],
});
