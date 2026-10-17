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
import type { ScriptTexts } from "../skill-scripts/run-skill-script.ts";
import { VM_WORKDIR } from "./vm-port.ts";

export const LINUX_VM_TOOLS_EXTENSION = "hm-linux-vm-tools";

const SECTION_KEY = "linux-vm";
const SECTION_TEXT = `You have a Linux VM. The read, write, edit and bash tools work in it, and ${VM_WORKDIR} is its working folder: a relative path starts there. bun and node are installed, and bun runs a .ts file directly. Commands have network access and see none of this platform's secrets. The VM sleeps when it has been idle for a few minutes, and the files in ${VM_WORKDIR} are kept for the next message. Nothing else in the VM is. The skills of this agent are in ${VM_WORKDIR}/skills/<name>/ and the files attached to the message are in ${VM_WORKDIR}/input/. The workspace library is not in the VM: reach it through the platform's library tools.`;

const PLAIN_SCRIPT_SENTENCE =
  "The script runs with bun in the Linux VM, with network access and none of this platform's secrets, and runs for at most";

/** What `run_skill_script` says when the script runs in the VM. */
export const VM_SCRIPT_TEXTS: ScriptTexts = {
  capabilities: `bun runs the script in ${VM_WORKDIR}, so it can import its own skill files and any package bun can install, read and write the session's files, and use the network.`,
  // The VM is given no granted secrets (see `secretsForEnvironment`), so the sentence for an agent with secrets is the plain one.
  granted: PLAIN_SCRIPT_SENTENCE,
  plain: PLAIN_SCRIPT_SENTENCE,
};

/** A read changes nothing, so it may run again after a restart. The others may not. */
export const linuxVmToolsExtension = (): Extension => ({
  name: LINUX_VM_TOOLS_EXTENSION,
  sections: [{ key: SECTION_KEY, render: () => SECTION_TEXT }],
  tools: [
    { ...createReadTool(), replay: "safe" },
    createWriteTool(),
    createEditTool(),
    // The VM's `exec` already passes only the variables it is given, and `prepare` adds none.
    createBashTool({
      prepare: (execution) => {
        execution.env = {};
        execution.inheritEnv = false;
      },
    }),
  ],
});
