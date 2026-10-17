import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { loadSkills, type SkillsPort } from "../pi-run-skills.ts";
import {
  type ScriptSecrets,
  skillScriptsExtension,
} from "../skill-scripts/run-skill-script.ts";
import { createFakeVm, type FakeVm } from "./fake-vm.ts";
import { vmSkillSandbox } from "./vm-skill-sandbox.ts";
import { VM_SCRIPT_TEXTS } from "./vm-tools.ts";

const NO_API = {} as ToolExecutionApi;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};
const SECRET_VALUE = "fake-secret-value-123";
const MASK = "[secret:FAKE_TOKEN]";
const SKILL_MD =
  "---\nname: shout\ndescription: Shouts the answer.\n---\nAnswer in capitals.\n";

const encode = (text: string) => new TextEncoder().encode(text);

const port: SkillsPort = {
  list: () =>
    Promise.resolve([
      { path: "shout/SKILL.md" },
      { path: "shout/scripts/hello.ts" },
    ]),
  read: (path) =>
    Promise.resolve(
      encode(path.endsWith("SKILL.md") ? SKILL_MD : "console.log(1);")
    ),
};

/** A grant with one env secret and its mask. */
const grant = (): ScriptSecrets => ({
  forRun: () =>
    Promise.resolve({
      env: { FAKE_TOKEN: SECRET_VALUE },
      mask: (text) => text.replaceAll(SECRET_VALUE, MASK),
      proxy: true,
    }),
});

/** A grant that only sends the proxy: no env, the mask does nothing. */
const proxyOnlyGrant = (): ScriptSecrets => ({
  forRun: () =>
    Promise.resolve({
      env: {},
      mask: (text) => text,
      proxy: true,
    }),
});

const extensionFor = async (
  vm: FakeVm,
  secrets: ScriptSecrets | undefined
): Promise<Extension> =>
  skillScriptsExtension(
    await loadSkills(port),
    port,
    vmSkillSandbox(vm),
    secrets,
    undefined,
    VM_SCRIPT_TEXTS
  );

const run = async (extension: Extension): Promise<ToolExecutionResult> => {
  const tool = extension.tools?.find((t) => t.name === "run_skill_script");
  if (tool === undefined) {
    throw new Error("no run_skill_script tool");
  }
  return (await tool.execute(
    { path: "scripts/hello.ts", skill: "shout" },
    NO_API,
    CONTEXT
  )) as ToolExecutionResult;
};

const resultText = (result: ToolExecutionResult): string =>
  (result.output ?? [])
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");

describe("secrets in a Linux VM session", () => {
  test("a granted env secret is set in the vm.exec env of run_skill_script", async () => {
    const vm = createFakeVm();
    await run(await extensionFor(vm, grant()));

    expect(vm.execCalls).toHaveLength(1);
    expect(vm.execCalls[0]?.env).toEqual({ FAKE_TOKEN: SECRET_VALUE });
  });

  test("a script's output that holds the secret comes back masked", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 0,
      stderr: `warn ${SECRET_VALUE}`,
      stdout: `token is ${SECRET_VALUE}`,
      timedOut: false,
      truncated: false,
    });
    const result = await run(await extensionFor(vm, grant()));

    expect(resultText(result)).toContain(MASK);
    expect(resultText(result)).not.toContain(SECRET_VALUE);
  });

  test("a grant with proxy and no env passes no env key", async () => {
    const vm = createFakeVm();
    await run(await extensionFor(vm, proxyOnlyGrant()));

    expect(vm.execCalls).toHaveLength(1);
    expect(vm.execCalls[0]).not.toHaveProperty("env");
  });

  test("an agent without a grant gets no env", async () => {
    const vm = createFakeVm();
    await run(await extensionFor(vm, undefined));

    expect(vm.execCalls).toHaveLength(1);
    expect(vm.execCalls[0]).not.toHaveProperty("env");
  });
});
