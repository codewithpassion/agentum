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
 * synced library copy's state for the Linux VM's prompt section. `taskFolderOf`
 * gives the run's task folder as a library path for the isolate's prompt section.
 *
 * `web_fetch` belongs to the isolate only, because a Linux VM reaches the
 * network through the VM itself. `network` gives the isolate's setting and the
 * fetcher. Without it the isolate gets no network tool or notice.
 *
 * `run_script` belongs to the isolate only, and only when `scripts` is given.
 * `taskFolderOf` is read by the isolate's library tools only. The Linux VM gets
 * its task folder through `libraryOf`. Both environments' prompt sections add
 * `computerInstructions` when `computerOf` answers a computer.
 *
 * `teamRoom` gives a lead's run in its team room the isolate's read-only set
 * even when `environment` is `linux-vm`: Pi's `read` from the library, and no
 * `write`, `edit`, `bash`, `web_fetch` or `run_script`. The VM tools go out. Without
 * `teamRoom`, or with it false, the environment works as described above.
 */
export const installEnvironmentTools = (
  registry: Pick<Registry, "install" | "uninstall">,
  environment: CloudEnvironment,
  slugOf: () => Promise<string | undefined>,
  libraryOf?: () => Promise<VmLibraryState | undefined>,
  network?: NetworkToolsOptions,
  scripts?: RunScriptDeps,
  taskFolderOf?: () => Promise<string | undefined>,
  computerOf?: () => Promise<{ desktop: boolean } | undefined>,
  teamRoom?: boolean
): void => {
  // A team room run never has the VM, and it gets no web_fetch or run_script.
  const inRoom = teamRoom === true;
  const isolate = inRoom || environment !== "linux-vm";
  const webFetch = inRoom ? undefined : network;
  const runScripts = inRoom ? undefined : scripts;
  // An extension that stays is installed over itself and keeps its place. Pi lists the tools in
  // install order, so taking it out first would move it to the end and make Pi re-declare every tool.
  if (!(isolate && webFetch)) {
    registry.uninstall({ name: NETWORK_TOOLS_EXTENSION });
  }
  if (!(isolate && runScripts)) {
    registry.uninstall({ name: RUN_SCRIPT_EXTENSION });
  }
  if (isolate) {
    registry.uninstall({ name: LINUX_VM_TOOLS_EXTENSION });
    registry.install(
      libraryToolsExtension(slugOf, taskFolderOf, computerOf, inRoom)
    );
    if (webFetch) {
      registry.install(networkToolsExtension(webFetch));
    }
    if (runScripts) {
      registry.install(runScriptExtension(runScripts));
    }
  } else {
    registry.uninstall({ name: LIBRARY_TOOLS_EXTENSION });
    registry.install(linuxVmToolsExtension(libraryOf, computerOf));
  }
};
