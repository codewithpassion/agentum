import type { Registry } from "@earendil-works/pi-durable";
import type { CloudEnvironment } from "@repo/services/cloud/environment";
import {
  LIBRARY_TOOLS_EXTENSION,
  libraryToolsExtension,
} from "../library-env/library-tools.ts";
import { LINUX_VM_TOOLS_EXTENSION, linuxVmToolsExtension } from "./vm-tools.ts";

/**
 * Gives a session the file and shell tools of its environment: Pi's `read`,
 * `write` and `edit` on the library for the isolate, or the same three plus
 * `bash` in the Linux VM. The other environment's set is taken out first, so a
 * session whose agent changed environment never holds both. `slugOf` gives the
 * agent's slug for the library tools' prompt section.
 */
export const installEnvironmentTools = (
  registry: Pick<Registry, "install" | "uninstall">,
  environment: CloudEnvironment,
  slugOf: () => Promise<string | undefined>
): void => {
  if (environment === "linux-vm") {
    registry.uninstall({ name: LIBRARY_TOOLS_EXTENSION });
    registry.install(linuxVmToolsExtension());
  } else {
    registry.uninstall({ name: LINUX_VM_TOOLS_EXTENSION });
    registry.install(libraryToolsExtension(slugOf));
  }
};
