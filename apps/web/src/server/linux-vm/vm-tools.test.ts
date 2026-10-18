import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { createFakeVm, type FakeVm, textOf } from "./fake-vm.ts";
import {
  createVmEnv,
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_OUTPUT_BYTES,
} from "./vm-env.ts";
import { VM_HOME_DIR, VM_LIBRARY_DIR, VM_WORKDIR } from "./vm-port.ts";
import {
  LINUX_VM_TOOLS_EXTENSION,
  linuxVmToolsExtension,
  VM_SCRIPT_TEXTS,
  type VmLibraryState,
} from "./vm-tools.ts";

const NOTE = "notes/a.md";
const NOTE_PATH = `${VM_HOME_DIR}/${NOTE}`;

const messageText = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : content.map((part) => ("text" in part ? String(part.text) : "")).join("");

/** The prompt section text of the Linux VM tools, with the library getter if one is given. */
const renderSection = async (
  libraryOf?: () => Promise<VmLibraryState | undefined>
): Promise<string | undefined> => {
  const [section] = linuxVmToolsExtension(libraryOf).sections ?? [];
  const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);
  return text;
};

interface Call {
  args: Record<string, unknown>;
  tool: string;
}

interface Answer {
  isError: boolean;
  text: string;
}

/** Runs the calls one after the other through a real harness whose env is the VM, and returns what each tool answered. */
const runCalls = async (calls: Call[], vm: FakeVm): Promise<Answer[]> => {
  const answers: Answer[] = [];
  const script = (context: TranscriptContext): AssistantMessage => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      answers.push({
        isError: last.isError,
        text: messageText(last.content),
      });
    }
    const next = calls[answers.length];
    if (next === undefined) {
      return fauxAssistantMessage([fauxText("done")]);
    }
    return fauxAssistantMessage([fauxToolCall(next.tool, next.args as never)], {
      stopReason: "toolUse",
    });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: calls.length + 1 }, () => script));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(linuxVmToolsExtension());

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      env: () => createVmEnv({ agentId: "a1", vm }),
      models,
      registry,
    },
    BACKGROUND_CONTEXT
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { modelId: faux.getModel().id, provider: faux.provider.id },
    },
  });
  const submission = await root.submit(
    { content: "go", type: "input" },
    BACKGROUND_CONTEXT
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  if (settled.status !== "done") {
    throw new Error(`the run ended as ${settled.status}`);
  }
  return answers;
};

describe("linuxVmToolsExtension", () => {
  test("offers read, write, edit and bash, and read may run again", () => {
    const extension = linuxVmToolsExtension();
    expect(extension.name).toBe(LINUX_VM_TOOLS_EXTENSION);
    expect(
      extension.tools?.map((tool) => [tool.name, tool.replay ?? "unsafe"])
    ).toEqual([
      ["read", "safe"],
      ["write", "unsafe"],
      ["edit", "unsafe"],
      ["bash", "unsafe"],
    ]);
  });

  test("its prompt section says the tools work in the VM, with the home, skills and input folders", async () => {
    const text = await renderSection();
    expect(text).toContain("Linux VM");
    expect(text).toContain(VM_HOME_DIR);
    expect(text).toContain(`${VM_WORKDIR}/skills`);
    expect(text).toContain(`${VM_WORKDIR}/input`);
    expect(text).toContain("Home:");
    expect(text).toContain("Scratch:");
  });

  test("its prompt section does not mention /library and names the library tools", async () => {
    const text = await renderSection();
    expect(text).not.toContain("/library");
    expect(text).toContain("library tools");
  });

  test("with a library state its prompt section names the synced copy and the rest of the library", async () => {
    const text = await renderSection(async () => ({
      conflicts: [],
      roots: ["agents/ada", "shared/brand"],
    }));
    expect(text).toContain(VM_LIBRARY_DIR);
    expect(text).toContain("agents/ada, shared/brand");
    expect(text).toContain(".conflict-<runId>");
    expect(text).toContain(
      "The rest of the library is not on your disk, so reach it with the library tools."
    );
    expect(text).not.toContain("- Conflicts:");
  });

  test("with a pending conflict its prompt section lists the conflict copy under the library folder", async () => {
    const text = await renderSection(async () => ({
      conflicts: ["agents/ada/notes.md.conflict-r1"],
      roots: ["agents/ada"],
    }));
    expect(text).toContain("- Conflicts:");
    expect(text).toContain(`${VM_LIBRARY_DIR}/agents/ada/notes.md.conflict-r1`);
  });

  test("a library getter that answers undefined gives the same text as no getter", async () => {
    const withoutGetter = await renderSection();
    const withUndefined = await renderSection(async () => undefined);
    expect(withUndefined).toBe(withoutGetter);
    expect(withUndefined).not.toContain(VM_LIBRARY_DIR);
  });

  test("the library getter is read each time the prompt renders", async () => {
    let state: VmLibraryState | undefined = {
      conflicts: [],
      roots: ["agents/ada"],
    };
    const extension = linuxVmToolsExtension(async () => state);
    const [section] = extension.sections ?? [];
    const first = await section?.render(undefined as never, BACKGROUND_CONTEXT);
    expect(first).toContain("agents/ada");

    state = undefined;
    const second = await section?.render(
      undefined as never,
      BACKGROUND_CONTEXT
    );
    expect(second).not.toContain(VM_LIBRARY_DIR);
    expect(second).toBe(await renderSection());
  });

  test("its prompt section says granted secrets are variables read as $NAME and shown as [secret:NAME]", async () => {
    const text = await renderSection();
    expect(text).toContain("network access");
    expect(text).toContain("$NAME");
    expect(text).toContain("[secret:NAME]");
    expect(text).not.toContain("none of this platform's secrets");
  });
});

describe("VM_SCRIPT_TEXTS", () => {
  test("a script with granted secrets reads them from process.env and has no plain-only wording", () => {
    expect(VM_SCRIPT_TEXTS.granted).toContain("process.env");
    expect(VM_SCRIPT_TEXTS.granted).toContain("network access");
    expect(VM_SCRIPT_TEXTS.granted).not.toContain("no secrets");
  });

  test("a script with no secrets says so", () => {
    expect(VM_SCRIPT_TEXTS.plain).toContain("no secrets");
  });
});

describe("Pi's file and shell tools in the Linux VM through a real harness", () => {
  test("write creates a file in the VM under the home folder", async () => {
    const vm = createFakeVm();
    await runCalls(
      [{ args: { content: "# Notes\n", path: NOTE }, tool: "write" }],
      vm
    );

    expect(textOf(vm.files.get(NOTE_PATH))).toBe("# Notes\n");
  });

  test("read returns what write stored", async () => {
    const vm = createFakeVm();
    const answers = await runCalls(
      [
        { args: { content: "alpha beta\n", path: NOTE }, tool: "write" },
        { args: { path: NOTE }, tool: "read" },
      ],
      vm
    );

    expect(answers[1]?.isError).toBe(false);
    expect(answers[1]?.text).toContain("alpha beta");
  });

  test("edit changes the file in the VM", async () => {
    const vm = createFakeVm();
    vm.files.set(NOTE_PATH, new TextEncoder().encode("alpha beta\n"));
    const answers = await runCalls(
      [
        {
          args: {
            edits: [{ newText: "gamma", oldText: "alpha" }],
            path: NOTE,
          },
          tool: "edit",
        },
      ],
      vm
    );

    expect(answers[0]?.isError).toBe(false);
    expect(textOf(vm.files.get(NOTE_PATH))).toBe("gamma beta\n");
  });

  test("bash answers with the command output and runs in the home folder with no variables of ours", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 0,
      stderr: "",
      stdout: "hello\n",
      timedOut: false,
      truncated: false,
    });
    const answers = await runCalls(
      [
        { args: { command: "echo hello", timeout: 5 }, tool: "bash" },
        { args: { command: "echo hello" }, tool: "bash" },
      ],
      vm
    );

    expect(answers[0]?.isError).toBe(false);
    expect(answers[0]?.text).toContain("hello");
    const [timed, untimed] = vm.execCalls;
    expect(timed?.command).toBe("echo hello");
    expect(timed?.cwd).toBe(VM_HOME_DIR);
    expect(timed?.env ?? {}).toEqual({});
    expect(timed?.maxOutputBytes).toBe(EXEC_OUTPUT_BYTES);
    expect(timed?.timeoutMs).toBe(5000);
    expect(untimed?.timeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  test("bash with a nonzero exit gives an error result", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 2,
      stderr: "boom\n",
      stdout: "",
      timedOut: false,
      truncated: false,
    });
    const answers = await runCalls(
      [{ args: { command: "false" }, tool: "bash" }],
      vm
    );

    expect(answers[0]?.isError).toBe(true);
    expect(answers[0]?.text).toContain("boom");
  });

  test("bash that times out gives an error result that says so", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 124,
      stderr: "",
      stdout: "",
      timedOut: true,
      truncated: false,
    });
    const answers = await runCalls(
      [{ args: { command: "sleep 99", timeout: 3 }, tool: "bash" }],
      vm
    );

    expect(answers[0]?.isError).toBe(true);
    expect(answers[0]?.text).toContain("timed out");
  });
});
