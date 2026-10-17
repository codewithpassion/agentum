import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  PromptInput,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { loadSkills, type SkillsPort } from "../pi-run-skills.ts";
import {
  type ScriptSecrets,
  skillScriptsExtension,
} from "../skill-scripts/run-skill-script.ts";
import { secretsForEnvironment } from "./environment-tools.ts";
import { createFakeVm } from "./fake-vm.ts";
import { vmSkillSandbox } from "./vm-skill-sandbox.ts";
import { VM_SCRIPT_TEXTS } from "./vm-tools.ts";

const NO_API = {} as ToolExecutionApi;
const NO_INPUT = {} as PromptInput;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};
const SECRET_VALUE = "fake-secret-value-123";
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

/** What the platform would grant this agent. The VM session must never ask for it. */
const grantedSecrets = (asked: { count: number }): ScriptSecrets => ({
  forRun: () => {
    asked.count += 1;
    return Promise.resolve({
      env: { FAKE_TOKEN: SECRET_VALUE },
      mask: (text) => text.replaceAll(SECRET_VALUE, "***"),
      proxy: true,
    });
  },
});

const extensionFor = async (
  environment: "isolate" | "linux-vm",
  asked: { count: number },
  vm: ReturnType<typeof createFakeVm>
): Promise<Extension> =>
  skillScriptsExtension(
    await loadSkills(port),
    port,
    vmSkillSandbox(vm),
    secretsForEnvironment(environment, grantedSecrets(asked)),
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

describe("secrets for a Linux VM session", () => {
  test("secretsForEnvironment passes the secrets to the isolate and none to the VM", () => {
    const secrets = grantedSecrets({ count: 0 });
    expect(secretsForEnvironment("isolate", secrets)).toBe(secrets);
    expect(secretsForEnvironment("linux-vm", secrets)).toBeUndefined();
  });

  test("a script in a VM session gets no granted secret: no lookup, no env, the plain prompt", async () => {
    const vm = createFakeVm();
    const asked = { count: 0 };
    const extension = await extensionFor("linux-vm", asked, vm);

    await run(extension);

    expect(asked.count).toBe(0);
    expect(vm.execCalls).toHaveLength(1);
    expect(vm.execCalls[0] !== undefined && "env" in vm.execCalls[0]).toBe(
      false
    );
    const prompt = await extension.sections?.[0]?.render(NO_INPUT, CONTEXT);
    expect(String(prompt)).toContain("none of this platform's secrets");
    expect(JSON.stringify(vm.execCalls)).not.toContain(SECRET_VALUE);
  });
});
