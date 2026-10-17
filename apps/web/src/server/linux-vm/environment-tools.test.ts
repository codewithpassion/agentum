import { describe, expect, test } from "bun:test";
import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import { LIBRARY_TOOLS_EXTENSION } from "../library-env/library-tools.ts";
import { installEnvironmentTools } from "./environment-tools.ts";
import { LINUX_VM_TOOLS_EXTENSION } from "./vm-tools.ts";

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
    installEnvironmentTools(registry, "linux-vm");

    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });

  test("isolate installs the library tools and no bash", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate");

    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);
  });

  test("switching environments leaves one set of tools each time", () => {
    const registry = createRegistry();
    installEnvironmentTools(registry, "isolate");
    installEnvironmentTools(registry, "linux-vm");
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);

    installEnvironmentTools(registry, "isolate");
    expect(extensionNames(registry)).toEqual([LIBRARY_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["edit", "read", "write"]);

    installEnvironmentTools(registry, "linux-vm");
    expect(extensionNames(registry)).toEqual([LINUX_VM_TOOLS_EXTENSION]);
    expect(toolNames(registry)).toEqual(["bash", "edit", "read", "write"]);
  });
});
