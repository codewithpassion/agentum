// Pi's own `read`, `write` and `edit` tools for a cloud run, working on the
// workspace library through `createLibraryEnv`. `bash` is left out: the
// environment has no shell, and the library `bash` tool over MCP covers it.
import type { Extension } from "@earendil-works/pi-durable";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { LIBRARY_MOUNT } from "../library-bash/run.ts";

export const LIBRARY_TOOLS_EXTENSION = "hm-library-tools";

const SECTION_KEY = "library-files";
const SECTION_TEXT = `The read, write and edit tools work on the workspace library, which is the folder ${LIBRARY_MOUNT}. A relative path starts there, and no other path exists. They run no commands: use the bash tool for that.`;

/** A read changes nothing, so it may run again after a restart. A write and an edit may not. */
export const libraryToolsExtension = (): Extension => ({
  name: LIBRARY_TOOLS_EXTENSION,
  sections: [{ key: SECTION_KEY, render: () => SECTION_TEXT }],
  tools: [
    { ...createReadTool(), replay: "safe" },
    createWriteTool(),
    createEditTool(),
  ],
});
