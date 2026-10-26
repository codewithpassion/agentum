import { beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
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
  type PromptInput,
} from "@earendil-works/pi-durable";
import { sqliteAtomic } from "@repo/db/atomic";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import { createLibraryEnv } from "./library-env.ts";
import {
  LIBRARY_TOOLS_EXTENSION,
  libraryToolsExtension,
} from "./library-tools.ts";

const WORKSPACE = "w1";
const START = "2026-10-17T10:00:00.000Z";
const NOTE = "notes/a.md";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

let service: ReturnType<typeof createLibraryService>;

const boundOps = (): LibraryOps => ({
  list: (dir) => service.list(user, dir),
  mkdir: (path) => service.mkdir(user, path),
  move: (from, to) => service.move(user, from, to),
  read: (path) => service.read(user, path),
  remove: (path, options) => service.remove(user, path, options),
  stat: (path) => service.stat(user, path),
  write: (path, content, options) =>
    service.write(user, path, content, options),
});

beforeEach(() => {
  const db = migrated();
  service = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      db,
    }),
  });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
});

const messageText = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : content.map((part) => ("text" in part ? String(part.text) : "")).join("");

interface Call {
  args: Record<string, unknown>;
  tool: string;
}

/** Runs the calls one after the other through a real harness, and returns what each tool answered. */
const runCalls = async (calls: Call[]): Promise<string[]> => {
  const answers: string[] = [];
  const script = (context: TranscriptContext): AssistantMessage => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      answers.push(messageText(last.content));
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
  registry.install(libraryToolsExtension(async () => "ada"));

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      env: () => createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE }),
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

const libraryText = async (path: string) =>
  decode((await service.read(user, path)).bytes);

describe("libraryToolsExtension", () => {
  test("offers read, write and edit, and read may run again", () => {
    const extension = libraryToolsExtension(async () => "ada");
    expect(extension.name).toBe(LIBRARY_TOOLS_EXTENSION);
    expect(
      extension.tools?.map((tool) => [tool.name, tool.replay ?? "unsafe"])
    ).toEqual([
      ["read", "safe"],
      ["write", "unsafe"],
      ["edit", "unsafe"],
    ]);
  });
});

const renderSection = async (
  slugOf: () => Promise<string | undefined>,
  taskFolderOf?: () => Promise<string | undefined>
): Promise<string> => {
  const section = libraryToolsExtension(slugOf, taskFolderOf).sections?.[0];
  if (section === undefined) {
    throw new Error("no section");
  }
  const text = await section.render({} as PromptInput, CONTEXT);
  if (text === undefined) {
    throw new Error("the section was omitted");
  }
  return text;
};

describe("libraryToolsExtension section", () => {
  test("names the agent's home in the library and no attachment marker", async () => {
    const text = await renderSection(async () => "ada");
    expect(text).toContain("/library/agents/ada");
    expect(text).not.toContain("[ATTACHMENT:");
    expect(text).toContain("no scratch folder");
    expect(text).toContain("kept for one tool call only");
  });

  test("names the library root when the agent has no slug yet", async () => {
    const text = await renderSection(async () => undefined);
    expect(text).toContain("/library");
    expect(text).not.toContain("agents/");
  });

  test("names the run's task folder in the library when taskFolderOf gives a path", async () => {
    const text = await renderSection(
      async () => "ada",
      async () => "agents/ada/tasks/run-1"
    );
    expect(text).toContain("/library/agents/ada/tasks/run-1");
    expect(text).toContain(
      "Save files for the user in /library/agents/ada/tasks/run-1."
    );
    expect(text).not.toContain("[ATTACHMENT:");
  });

  test("names no task folder and no attachment marker when taskFolderOf gives nothing", async () => {
    const text = await renderSection(
      async () => "ada",
      async () => undefined
    );
    expect(text).not.toContain("Save files for the user");
    expect(text).not.toContain("[ATTACHMENT:");
    expect(text).toBe(await renderSection(async () => "ada"));
  });

  test("tells the isolate agent about its run_script tool", async () => {
    const text = await renderSection(async () => "ada");
    expect(text).toContain("run_script");
  });
});

describe("Pi's file tools through a real harness", () => {
  test("edit changes a library file that read then shows changed", async () => {
    await service.write(user, NOTE, encode("alpha beta\n"));
    const answers = await runCalls([
      { args: { path: `/library/${NOTE}` }, tool: "read" },
      {
        args: {
          edits: [{ newText: "gamma", oldText: "alpha" }],
          path: `/library/${NOTE}`,
        },
        tool: "edit",
      },
      { args: { path: NOTE }, tool: "read" },
    ]);

    expect(answers[0]).toContain("alpha beta");
    expect(answers[2]).toContain("gamma beta");
    expect(await libraryText(NOTE)).toBe("gamma beta\n");
  });

  test("write creates a file and its folder in the library", async () => {
    await runCalls([
      {
        args: { content: "fresh", path: "/library/new/b.md" },
        tool: "write",
      },
    ]);

    expect(await libraryText("new/b.md")).toBe("fresh");
    expect((await service.stat(user, "new")).kind).toBe("dir");
  });

  test("a path outside the library fails and writes nothing", async () => {
    const answers = await runCalls([
      { args: { content: "x", path: "/etc/passwd" }, tool: "write" },
    ]);

    expect(answers[0]).toContain("/library");
    await expect(service.stat(user, "etc")).rejects.toThrow();
  });
});
