import type { Registry } from "@earendil-works/pi-durable";
import type { CloudEnvironment } from "@repo/services/cloud/environment";
import {
  LIBRARY_TOOLS_EXTENSION,
  libraryToolsExtension,
} from "../library-env/library-tools.ts";
import {
  RUN_SCRIPT_EXTENSION,
  type RunScriptDeps,
  runScriptExtension,
} from "../skill-scripts/run-script.ts";
import {
  NETWORK_TOOLS_EXTENSION,
  type NetworkToolsOptions,
  networkToolsExtension,
} from "../web-fetch/pi-tool.ts";
import {
  LINUX_VM_TOOLS_EXTENSION,
  linuxVmToolsExtension,
  type VmLibraryState,
} from "./vm-tools.ts";

/**
 * Gives a session the file and shell tools of its environment: Pi's `read`,
 * `write` and `edit` on the library for the isolate, or the same three plus
 * `bash` in the Linux VM. The other environment's set is taken out first, so a
 * session whose agent changed environment never holds both. `slugOf` gives the
 * agent's slug for the library tools' prompt section. `libraryOf` gives the
 * synced library copy's state for the Linux VM's prompt section.
 *
 * `web_fetch` belongs to the isolate only, because a Linux VM reaches the
 * network through the VM itself. `network` gives the isolate's setting and the
 * fetcher. Without it the isolate gets no network tool or notice.
 *
 * `run_script` belongs to the isolate only, and only when `scripts` is given.
 */
export const installEnvironmentTools = (
  registry: Pick<Registry, "install" | "uninstall">,
  environment: CloudEnvironment,
  slugOf: () => Promise<string | undefined>,
  libraryOf?: () => Promise<VmLibraryState | undefined>,
  network?: NetworkToolsOptions,
  scripts?: RunScriptDeps
): void => {
  registry.uninstall({ name: NETWORK_TOOLS_EXTENSION });
  registry.uninstall({ name: RUN_SCRIPT_EXTENSION });
  if (environment === "linux-vm") {
    registry.uninstall({ name: LIBRARY_TOOLS_EXTENSION });
    registry.install(linuxVmToolsExtension(libraryOf));
  } else {
    registry.uninstall({ name: LINUX_VM_TOOLS_EXTENSION });
    registry.install(libraryToolsExtension(slugOf));
    if (network) {
      registry.install(networkToolsExtension(network));
    }
    if (scripts) {
      registry.install(runScriptExtension(scripts));
    }
  }
};
