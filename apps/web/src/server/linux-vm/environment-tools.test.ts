import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import { LIBRARY_TOOLS_EXTENSION } from "../library-env/library-tools.ts";
import {
  RUN_SCRIPT_EXTENSION,
  type RunScriptDeps,
} from "../skill-scripts/run-script.ts";
import { NETWORK_TOOLS_EXTENSION } from "../web-fetch/pi-tool.ts";
import type { WebFetcher } from "../web-fetch/types.ts";
import { installEnvironmentTools } from "./environment-tools.ts";
import { VM_LIBRARY_DIR } from "./vm-port.ts";
import { LINUX_VM_TOOLS_EXTENSION } from "./vm-tools.ts";

const slugOf = async () => "ada";
const fetcherOf = (): Promise<WebFetcher> =>
  Promise.reject(new Error("not called"));
const scriptsOf: RunScriptDeps = {
  homeOf: async () => "agents/ada",
  read: async () => null,
  record: async () => undefined,
  sandboxOf: () => Promise.reject(new Error("not called")),
};

const toolNames = (registry: Registry): string[] =>
  registry
    .snapshot()
    .tools()
    .map(({ tool }) => tool.name)
    .sort();

const extensionNames = (registry: Registry): string[] =>
  registry
    .snapshot()
    .installed()
    .map((extension) => extension.name)
    .sort();

describe("installEnvironmentTools", () => {
  test("linux-vm installs the VM tools and no library tools", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "linux-vm", slugOf);

    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });

  test("isolate installs the library tools and no bash", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf);

    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);
  });

  test("linux-vm passes libraryOf to the VM tools' prompt section", async () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "linux-vm", slugOf, async () => ({
      conflicts: [],
      roots: [{ mode: "write", path: "agents/ada" }],
    }));

    const extension = registry
      .snapshot()
      .installed()
      .find((installed) => installed.name === LINUX_VM_TOOLS_EXTENSION);
    const [section] = extension?.sections ?? [];
    const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);
    expect(text).toContain(VM_LIBRARY_DIR);
    expect(text).toContain("agents/ada (write)");
  });

  test("isolate passes taskFolderOf to the library tools' prompt section", async () => {
    const registry = createRegistry();
    installEnvironmentTools(
      registry,
      "isolate",
      slugOf,
      undefined,
      undefined,
      undefined,
      async () => "agents/ada/tasks/run-1"
    );

    const extension = registry
      .snapshot()
      .installed()
      .find((installed) => installed.name === LIBRARY_TOOLS_EXTENSION);
    const [section] = extension?.sections ?? [];
    const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);
    expect(text).toContain("/library/agents/ada/tasks/run-1");
  });

  test.each([
    ["linux-vm", LINUX_VM_TOOLS_EXTENSION],
    ["isolate", LIBRARY_TOOLS_EXTENSION],
  ] as const)(
    "%s adds the computer paragraph only when computerOf answers",
    async (environment, extensionName) => {
      const sectionText = async (
        computerOf?: () => Promise<{ desktop: boolean } | undefined>
      ) => {
        const registry = createRegistry();
        installEnvironmentTools(
          registry,
          environment,
          slugOf,
          undefined,
          undefined,
          undefined,
          undefined,
          computerOf
        );
        const extension = registry
          .snapshot()
          .installed()
          .find((installed) => installed.name === extensionName);
        const [section] = extension?.sections ?? [];
        return await section?.render(undefined as never, BACKGROUND_CONTEXT);
      };

      expect(await sectionText()).not.toContain("computer_exec");
      expect(await sectionText(async () => undefined)).not.toContain(
        "computer_exec"
      );
      const plain = await sectionText(async () => ({ desktop: false }));
      expect(plain).toContain("computer_exec");
      expect(plain).not.toContain("desktop_screenshot");
      expect(await sectionText(async () => ({ desktop: true }))).toContain(
        "desktop_screenshot"
      );
    }
  );

  test("switching environments leaves one set of tools each time", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf);
    installEnvironmentTools(registry, "linux-vm", slugOf);
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);

    installEnvironmentTools(registry, "isolate", slugOf);
    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);

    installEnvironmentTools(registry, "linux-vm", slugOf);
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });

  test("installing the isolate again keeps the tools in place", () => {
    const registry = createRegistry();
    const network = { enabled: true, fetcherOf };
    const order = () =>
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name);
    installEnvironmentTools(
      registry,
      "isolate",
      slugOf,
      undefined,
      network,
      scriptsOf
    );
    registry.install({ name: "mcp-later", tools: [] });
    const before = order();

    installEnvironmentTools(
      registry,
      "isolate",
      slugOf,
      undefined,
      network,
      scriptsOf
    );

    expect(order()).toEqual(before);
    expect(
      registry
        .snapshot()
        .installed()
        .map((extension) => extension.name)
    ).toEqual([
      LIBRARY_TOOLS_EXTENSION,
      NETWORK_TOOLS_EXTENSION,
      RUN_SCRIPT_EXTENSION,
      "mcp-later",
    ]);
  });

  test("isolate with network access installs web_fetch", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf, undefined, {
      enabled: true,
      fetcherOf,
    });

    expect(extensionNames(registry)).toEqual([
      LIBRARY_TOOLS_EXTENSION,
      NETWORK_TOOLS_EXTENSION,
    ]);
    expect(toolNames(registry)).toEqual(["edit", "read", "web_fetch", "write"]);
  });

  test("isolate without network access installs the one-line notice and no web_fetch", async () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf, undefined, {
      enabled: false,
      fetcherOf,
    });

    expect(extensionNames(registry)).toEqual([
      LIBRARY_TOOLS_EXTENSION,
      NETWORK_TOOLS_EXTENSION,
    ]);
    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);

    const extension = registry
      .snapshot()
      .installed()
      .find((installed) => installed.name === NETWORK_TOOLS_EXTENSION);
    const [section] = extension?.sections ?? [];
    const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);
    expect(text).toContain("web_fetch");
    expect(text?.split("\n")).toHaveLength(1);
  });

  test("isolate without the network setting installs no network extension", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf);
    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
  });

  test("linux-vm installs no network extension", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "linux-vm", slugOf, undefined, {
      enabled: true,
      fetcherOf,
    });
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
  });

  test("isolate with scripts installs run_script", () => {
    const registry = createRegistry();
    installEnvironmentTools(
      registry,
      "isolate",
      slugOf,
      undefined,
      undefined,
      scriptsOf
    );

    expect(extensionNames(registry)).toEqual([
      LIBRARY_TOOLS_EXTENSION,
      RUN_SCRIPT_EXTENSION,
    ]);
    expect(toolNames(registry)).toEqual([
      "edit",
      "read",
      "run_script",
      "write",
    ]);
  });

  test("isolate without scripts installs no run_script", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf);
    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
  });

  test("linux-vm with scripts installs no run_script", () => {
    const registry = createRegistry();
    installEnvironmentTools(
      registry,
      "linux-vm",
      slugOf,
      undefined,
      undefined,
      scriptsOf
    );
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
  });

  test("switching from isolate to linux-vm removes run_script", () => {
    const registry = createRegistry();
    installEnvironmentTools(
      registry,
      "isolate",
      slugOf,
      undefined,
      undefined,
      scriptsOf
    );
    installEnvironmentTools(registry, "linux-vm", slugOf);

    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });

  test("switching from isolate to linux-vm removes web_fetch", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf, undefined, {
      enabled: true,
      fetcherOf,
    });
    installEnvironmentTools(registry, "linux-vm", slugOf, undefined, {
      enabled: true,
      fetcherOf,
    });

    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });

  test("turning network access off removes web_fetch", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate", slugOf, undefined, {
      enabled: true,
      fetcherOf,
    });
    installEnvironmentTools(registry, "isolate", slugOf, undefined, {
      enabled: false,
      fetcherOf,
    });

    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);
    expect(extensionNames(registry)).toEqual([
      LIBRARY_TOOLS_EXTENSION,
      NETWORK_TOOLS_EXTENSION,
    ]);
  });
});
