// Pi's own `read`, `write`, `edit` and `bash` for a cloud run whose agent has a
// Linux VM, working in the VM through `createVmEnv`. They replace the library
// file tools (`library-env/library-tools.ts`) for that session. The prompt
// section also names the synced library copy in the VM and its pending conflict
// copies, read from `libraryOf` each time the prompt renders.
import type { Extension } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { LibraryAccessGrant } from "@repo/db/shared";
import {
  computerInstructions,
  workspaceInstructions,
} from "@repo/protocol/attachments";
import type { ScriptTexts } from "../skill-scripts/run-skill-script.ts";
import { VM_HOME_DIR, VM_LIBRARY_DIR, VM_WORKDIR } from "./vm-port.ts";

export const LINUX_VM_TOOLS_EXTENSION = "hm-linux-vm-tools";

/** The synced library copy in the VM, as the prompt section names it. */
export interface VmLibraryState {
  /** Library paths of conflict copies still waiting. */
  conflicts: readonly string[];
  /** Library paths copied to the VM's library folder, with the access mode of each. */
  roots: readonly LibraryAccessGrant[];
  /** The run's task folder as a library path, such as `agents/ada/tasks/run-1`. */
  taskFolder?: string;
}

const SECTION_KEY = "linux-vm";
const SCRATCH_DIR = "/tmp";
const VM_FACTS = `You have a Linux VM. The read, write, edit and bash tools work in it, and a relative path starts in the home folder. bun and node are installed, and bun runs a .ts file directly. Commands have network access. Any secrets this agent was granted are set as environment variables for commands: read them as $NAME. If one appears in output, you see it as [secret:NAME]. Never print a secret or write it to a file. HTTPS requests to a host the agent has a credential for get that credential added by the platform, so do not add it yourself. The skills of this agent are in ${VM_WORKDIR}/skills/<name>/ and the files attached to the message are in ${VM_WORKDIR}/input/. Both are scratch and are placed again for each message. The VM sleeps when it has been idle for a few minutes.`;

const sectionText = (state: VmLibraryState | undefined): string =>
  `${VM_FACTS}\n\n${workspaceInstructions({
    attachments: false,
    conflicts: state?.conflicts,
    home: VM_HOME_DIR,
    homeIsLocal: true,
    library: state ? VM_LIBRARY_DIR : null,
    liveSync: true,
    roots: state?.roots,
    scratch: { lasts: "vm-sleep", path: SCRATCH_DIR },
    taskFolder: state?.taskFolder
      ? `${VM_LIBRARY_DIR}/${state.taskFolder}`
      : undefined,
  })}`;

/** What `run_skill_script` says when the script runs in the VM. */
export const VM_SCRIPT_TEXTS: ScriptTexts = {
  capabilities: `bun runs the script in ${VM_HOME_DIR}, so it can import its own skill files and any package bun can install, read and write the agent's files, and use the network.`,
  granted:
    "The script runs with bun in the Linux VM, with network access. The environment variables the agent was granted are set in process.env, and HTTPS requests to hosts the agent has a credential for get that credential added for it. It runs for at most",
  plain:
    "The script runs with bun in the Linux VM, with network access and no secrets, and runs for at most",
};

/**
 * A read changes nothing, so it may run again after a restart. The others may
 * not. `libraryOf` answers the synced library copy's state, including the run's
 * task folder, when the prompt renders, or undefined when there is none, and
 * then the section leaves the library path and the task folder out. `computerOf`
 * answers the agent's attached computer when the prompt renders, and the section
 * then adds how to use it.
 */
export const linuxVmToolsExtension = (
  libraryOf?: () => Promise<VmLibraryState | undefined>,
  computerOf?: () => Promise<{ desktop: boolean } | undefined>
): Extension => ({
  name: LINUX_VM_TOOLS_EXTENSION,
  sections: [
    {
      key: SECTION_KEY,
      render: async () => {
        const text = sectionText(await libraryOf?.());
        const computer = await computerOf?.();
        return computer ? `${text}\n\n${computerInstructions(computer)}` : text;
      },
    },
  ],
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
