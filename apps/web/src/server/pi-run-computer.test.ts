import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PortResult, ToolImage } from "@repo/mcp/ports";
import type { RequestOutcome } from "@repo/protocol/requests";
import {
  COMPUTER_EXTENSION,
  type ComputerToolDeps,
  computerExtension,
  installComputer,
} from "./pi-run-computer.ts";
import { createGate, type GateRequests, gateExtension } from "./pi-run-gate.ts";

const IMAGE: ToolImage = { data: "aGVsbG8=", mimeType: "image/png" };
const DESKTOP = { desktop: true, machineId: "m1" } as const;
const SCREENSHOT = "desktop_screenshot";
const TAKEOVER = "request_human_takeover";

/** Screenshots go through this port. `reply` is what the next screenshot answers. */
const fakeScreenshots = (
  reply: () => PortResult<{ image: ToolImage }> = () => ({
    image: IMAGE,
    ok: true,
  })
) => {
  const calls: string[] = [];
  const screenshot: ComputerToolDeps["screenshot"] = (machineId) => {
    calls.push(machineId);
    return Promise.resolve(reply());
  };
  return { calls, screenshot };
};

const takeoverStub: ToolRegistration = {
  description: "stub",
  execute: () => Promise.resolve({ output: [] }),
  name: TAKEOVER,
  parameters: Type.Object({}),
};

const depsOf = (
  screenshot: ComputerToolDeps["screenshot"],
  takeover: ToolRegistration = takeoverStub
): ComputerToolDeps => ({ screenshot, takeover });

const toolOf = (
  extension: ReturnType<typeof computerExtension>,
  name: string
): ToolRegistration => {
  const tool = extension?.tools?.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`no ${name} tool`);
  }
  return tool;
};

const apiOf = (callId: string) => ({ callId }) as ToolExecutionApi;

describe("computerExtension", () => {
  const { screenshot } = fakeScreenshots();

  test("has no tools without a computer", () => {
    expect(computerExtension(undefined, depsOf(screenshot))).toBeUndefined();
  });

  test("has no tools for a computer without a desktop", () => {
    expect(
      computerExtension({ desktop: false, machineId: "m1" }, depsOf(screenshot))
    ).toBeUndefined();
  });

  test("brings the screenshot and the takeover tools for a desktop", () => {
    const extension = computerExtension(DESKTOP, depsOf(screenshot));

    expect(extension?.name).toBe(COMPUTER_EXTENSION);
    expect(extension?.tools?.map((tool) => tool.name)).toEqual([
      SCREENSHOT,
      TAKEOVER,
    ]);
    expect(toolOf(extension, SCREENSHOT).replay).toBe("safe");
  });
});

describe("installComputer", () => {
  const names = (registry: ReturnType<typeof createRegistry>) =>
    registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name);

  test("installs the tools for a desktop and takes them out when the computer is gone", () => {
    const registry = createRegistry();
    const deps = depsOf(fakeScreenshots().screenshot);

    installComputer(registry, DESKTOP, deps);
    expect(names(registry)).toEqual([SCREENSHOT, TAKEOVER]);

    installComputer(registry, undefined, deps);
    expect(names(registry)).toEqual([]);
  });

  test("a computer without a desktop leaves none", () => {
    const registry = createRegistry();

    installComputer(
      registry,
      { desktop: false, machineId: "m1" },
      depsOf(fakeScreenshots().screenshot)
    );

    expect(names(registry)).toEqual([]);
  });

  test("installing again keeps the tools in place", () => {
    const registry = createRegistry();
    const deps = depsOf(fakeScreenshots().screenshot);
    installComputer(registry, DESKTOP, deps);
    registry.install({ name: "mcp-later", tools: [] });
    const before = names(registry);

    installComputer(registry, DESKTOP, deps);

    expect(names(registry)).toEqual(before);
  });
});

describe("the desktop_screenshot tool", () => {
  test("asks for the computer's own machine and returns the picture as an image block", async () => {
    const fake = fakeScreenshots();
    const tool = toolOf(
      computerExtension(DESKTOP, depsOf(fake.screenshot)),
      SCREENSHOT
    );

    const result = await tool.execute({}, apiOf("c1"), BACKGROUND_CONTEXT);

    expect(fake.calls).toEqual(["m1"]);
    expect(result).toEqual({
      isError: false,
      output: [{ data: IMAGE.data, mimeType: IMAGE.mimeType, type: "image" }],
    });
  });

  test("tells the model why when the computer is offline", async () => {
    const fake = fakeScreenshots(() => ({
      code: "offline",
      ok: false,
      reason: "The computer is offline.",
    }));
    const tool = toolOf(
      computerExtension(DESKTOP, depsOf(fake.screenshot)),
      SCREENSHOT
    );

    const result = await tool.execute({}, apiOf("c1"), BACKGROUND_CONTEXT);

    expect(result).toEqual({
      isError: true,
      output: [{ text: "The computer is offline.", type: "text" }],
    });
  });

  test("names the code when the failure has no reason", async () => {
    const fake = fakeScreenshots(() => ({
      code: "human_in_control",
      ok: false,
    }));
    const tool = toolOf(
      computerExtension(DESKTOP, depsOf(fake.screenshot)),
      SCREENSHOT
    );

    const result = await tool.execute({}, apiOf("c1"), BACKGROUND_CONTEXT);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("human_in_control");
  });

  test("a port that throws becomes an error result, not a failed call", async () => {
    const tool = toolOf(
      computerExtension(
        DESKTOP,
        depsOf(() => Promise.reject(new Error("relay down")))
      ),
      SCREENSHOT
    );

    const result = await tool.execute({}, apiOf("c1"), BACKGROUND_CONTEXT);

    expect(result).toEqual({
      isError: true,
      output: [
        { text: "The desktop screenshot failed: relay down", type: "text" },
      ],
    });
  });
});

// Through Pi Durable itself: what the model reads, and a takeover that holds the
// call until the person hands the computer back.
describe("with Pi Durable", () => {
  const HANDED_BACK: RequestOutcome = {
    answer: { note: "Signed in." },
    status: "answered",
  };

  /** A requests service that keeps what the gate opened. */
  const fakeRequests = () => {
    const rows: { id: string; outcome: RequestOutcome | null }[] = [];
    const port: GateRequests = {
      needsApproval: () => Promise.resolve(false),
      open: () => {
        const [existing] = rows;
        const row = existing ?? { id: "req1", outcome: null };
        if (!existing) {
          rows.push(row);
        }
        return Promise.resolve({ id: row.id, outcome: row.outcome });
      },
      outcome: (requestId) =>
        Promise.resolve(
          rows.find((row) => row.id === requestId)?.outcome ?? null
        ),
    };
    return { port, rows };
  };

  const open = async (
    tool: string,
    args: Record<string, string>,
    screenshot: ComputerToolDeps["screenshot"],
    requests: GateRequests
  ) => {
    const seen: TranscriptContext[] = [];
    const gate = createGate({
      isDryRun: () => Promise.resolve(false),
      maskerOf: () => Promise.resolve(null),
      originOf: () => undefined,
      recordSkip: () => Promise.resolve(),
      requests,
      runIdOf: () => Promise.resolve("run1"),
      serverKeys: () => [],
    });
    const faux = fauxProvider();
    faux.setResponses([
      (context: TranscriptContext): AssistantMessage => {
        seen.push(context);
        return fauxAssistantMessage([fauxToolCall(tool, args)], {
          stopReason: "toolUse",
        });
      },
      (context: TranscriptContext): AssistantMessage => {
        seen.push(context);
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(gateExtension(gate));
    installComputer(
      registry,
      DESKTOP,
      depsOf(screenshot, gate.requestTakeover)
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { modelId: faux.getModel().id, provider: faux.provider.id },
      },
    });
    return { gate, harness, root, seen };
  };

  test("the image block reaches the model call", async () => {
    const fake = fakeScreenshots();
    const { harness, root, seen } = await open(
      SCREENSHOT,
      {},
      fake.screenshot,
      fakeRequests().port
    );

    const submission = await root.submit(
      { content: "look", type: "input" },
      BACKGROUND_CONTEXT
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    const last = seen.at(-1)?.messages.at(-1);
    expect(last?.role).toBe("toolResult");
    expect(last?.content).toEqual([
      { data: IMAGE.data, mimeType: IMAGE.mimeType, type: "image" },
    ]);
    await harness.close(BACKGROUND_CONTEXT);
  });

  test("a takeover holds the call until the hand-back, then the model reads the note", async () => {
    const fake = fakeRequests();
    const { gate, harness, root, seen } = await open(
      TAKEOVER,
      { reason: "Sign in." },
      fakeScreenshots().screenshot,
      fake.port
    );

    const submission = await root.submit(
      { content: "go", type: "input" },
      BACKGROUND_CONTEXT
    );
    for (let round = 0; round < 200 && fake.rows.length === 0; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    // The run waits inside the tool call: the model has not been asked again.
    expect(seen).toHaveLength(1);

    const [row] = fake.rows;
    if (row) {
      row.outcome = HANDED_BACK;
    }
    gate.answered("req1");
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen.at(-1)?.messages.at(-1)?.content)).toContain(
      "A person took over the computer and handed it back. Note: Signed in."
    );
    await harness.close(BACKGROUND_CONTEXT);
  });
});
