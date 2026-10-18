// Pi's own `read`, `write`, `edit` and `bash` for a cloud run whose agent has a
// Linux VM, working in the VM through `createVmEnv`. They replace the library
// file tools (`library-env/library-tools.ts`) for that session.
import type { Extension } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { workspaceInstructions } from "@repo/protocol/attachments";
import type { ScriptTexts } from "../skill-scripts/run-skill-script.ts";
import { VM_HOME_DIR, VM_WORKDIR } from "./vm-port.ts";

export const LINUX_VM_TOOLS_EXTENSION = "hm-linux-vm-tools";

const SECTION_KEY = "linux-vm";
const SCRATCH_DIR = "/tmp";
const VM_FACTS = `You have a Linux VM. The read, write, edit and bash tools work in it, and a relative path starts in the home folder. bun and node are installed, and bun runs a .ts file directly. Commands have network access. Any secrets this agent was granted are set as environment variables for commands: read them as $NAME. If one appears in output, you see it as [secret:NAME]. Never print a secret or write it to a file. HTTPS requests to a host the agent has a credential for get that credential added by the platform, so do not add it yourself. The skills of this agent are in ${VM_WORKDIR}/skills/<name>/ and the files attached to the message are in ${VM_WORKDIR}/input/. Both are scratch and are placed again for each message. The VM sleeps when it has been idle for a few minutes.`;
const WORKSPACE_TEXT = workspaceInstructions({
  home: VM_HOME_DIR,
  homeIsLocal: true,
  library: null,
  scratch: { lasts: "vm-sleep", path: SCRATCH_DIR },
});
const SECTION_TEXT = `${VM_FACTS}\n\n${WORKSPACE_TEXT}`;

/** What `run_skill_script` says when the script runs in the VM. */
export const VM_SCRIPT_TEXTS: ScriptTexts = {
  capabilities: `bun runs the script in ${VM_HOME_DIR}, so it can import its own skill files and any package bun can install, read and write the session's files, and use the network.`,
  granted:
    "The script runs with bun in the Linux VM, with network access. The environment variables the agent was granted are set in process.env, and HTTPS requests to hosts the agent has a credential for get that credential added for it. It runs for at most",
  plain:
    "The script runs with bun in the Linux VM, with network access and no secrets, and runs for at most",
};

/** A read changes nothing, so it may run again after a restart. The others may not. */
export const linuxVmToolsExtension = (): Extension => ({
  name: LINUX_VM_TOOLS_EXTENSION,
  sections: [{ key: SECTION_KEY, render: () => SECTION_TEXT }],
  tools: [
    { ...createReadTool(), replay: "safe" },
    createWriteTool(),
    createEditTool(),
    // `execution.env = {}` means this tool adds no variable of its own. The granted secrets are added by the VM environment (vm-env.ts).
    createBashTool({
      prepare: (execution) => {
        execution.env = {};
        execution.inheritEnv = false;
      },
    }),
  ],
});
