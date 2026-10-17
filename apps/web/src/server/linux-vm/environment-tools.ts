import type { Registry } from "@earendil-works/pi-durable";
import type { CloudEnvironment } from "@repo/services/cloud/environment";
import {
  LIBRARY_TOOLS_EXTENSION,
  libraryToolsExtension,
} from "../library-env/library-tools.ts";
import { LINUX_VM_TOOLS_EXTENSION, linuxVmToolsExtension } from "./vm-tools.ts";

/**
 * The secrets an agent was granted, as the script tool should get them. The
 * Linux VM gets none: only a script's answer is masked, and the VM's own
 * `bash`, `read` and the snapshot are not, so S.4 delivers secrets to a VM
 * together with that redaction.
 */
export const secretsForEnvironment = <T>(
  environment: CloudEnvironment,
  secrets: T
): T | undefined => (environment === "linux-vm" ? undefined : secrets);

/**
 * Gives a session the file and shell tools of its environment: Pi's `read`,
 * `write` and `edit` on the library for the isolate, or the same three plus
 * `bash` in the Linux VM. The other environment's set is taken out first, so a
 * session whose agent changed environment never holds both.
 */
export const installEnvironmentTools = (
  registry: Pick<Registry, "install" | "uninstall">,
  environment: CloudEnvironment
): void => {
  if (environment === "linux-vm") {
    registry.uninstall({ name: LIBRARY_TOOLS_EXTENSION });
    registry.install(linuxVmToolsExtension());
  } else {
    registry.uninstall({ name: LINUX_VM_TOOLS_EXTENSION });
    registry.install(libraryToolsExtension());
  }
};
