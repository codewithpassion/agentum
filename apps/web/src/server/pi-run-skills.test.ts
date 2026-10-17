import { describe, expect, test } from "bun:test";
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
  type Extension,
  Harness,
  MemoryStorage,
  type PromptInput,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  loadSkills,
  SKILLS_EXTENSION,
  type SkillsPort,
  skillsExtension,
} from "./pi-run-skills.ts";

// The skill tools never read the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const NO_INPUT = {} as PromptInput;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const SHOUT_BODY = "Answer in capitals.";
const SHOUT_MD = `---\nname: shout\ndescription: Shouts the answer.\n---\n${SHOUT_BODY}\n`;
const NOTE_TEXT = "A note bundled with the skill.";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A port over a map of path to text. The map is read on every call, so a test can edit it. */
const portOver = (files: Record<string, string>): SkillsPort => ({
  list: () => Promise.resolve(Object.keys(files).map((path) => ({ path }))),
  read: (path) => {
    const text = files[path];
    if (text === undefined) {
      return Promise.reject(new Error(`no such file: ${path}`));
    }
    return Promise.resolve(encode(text));
  },
});

const textOf = (result: ToolExecutionResult): string => {
  const content = result.output;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => ("text" in part ? part.text : "")).join("");
};

const messageText = (content: Message["content"] | undefined): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

const toolNamed = (extension: Extension, name: string): ToolRegistration => {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return tool;
};

const execute = (
  extension: Extension,
  name: string,
  args: unknown
): Promise<ToolExecutionResult> =>
  toolNamed(extension, name).execute(
    args,
    NO_API,
    CONTEXT
  ) as Promise<ToolExecutionResult>;

describe("loadSkills", () => {
  test("groups the listed files by folder and keeps the other files", async () => {
    const skills = await loadSkills(
      portOver({
        "shout/b.txt": "b",
        "shout/notes/a.md": NOTE_TEXT,
        "shout/SKILL.md": SHOUT_MD,
      })
    );
    expect(skills).toEqual([
      {
        description: "Shouts the answer.",
        files: ["shout/b.txt", "shout/notes/a.md"],
        name: "shout",
      },
    ]);
  });

  test("skips a folder without SKILL.md", async () => {
    const skills = await loadSkills(
      portOver({
        "loose/readme.md": "not a skill",
        "shout/SKILL.md": SHOUT_MD,
      })
    );
    expect(skills.map((skill) => skill.name)).toEqual(["shout"]);
  });

  test("skips a folder whose frontmatter is bad", async () => {
    const skills = await loadSkills(
      portOver({
        "bare/SKILL.md": "no frontmatter here",
        "mismatch/SKILL.md": SHOUT_MD,
        "shout/SKILL.md": SHOUT_MD,
      })
    );
    expect(skills.map((skill) => skill.name)).toEqual(["shout"]);
  });

  test("sorts the skills by name", async () => {
    const skills = await loadSkills(
      portOver({
        "alpha/SKILL.md": SHOUT_MD.replace("shout", "alpha"),
        "zeta/SKILL.md": SHOUT_MD.replace("shout", "zeta"),
      })
    );
    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
  });

  test("skips a folder whose read throws and keeps the rest", async () => {
    const files: Record<string, string> = {
      "broken/SKILL.md": SHOUT_MD,
      "shout/SKILL.md": SHOUT_MD,
    };
    const port: SkillsPort = {
      list: () => Promise.resolve(Object.keys(files).map((path) => ({ path }))),
      read: (path) => {
        if (path === "broken/SKILL.md") {
          return Promise.reject(new Error("disk on fire"));
        }
        return Promise.resolve(encode(files[path] ?? ""));
      },
    };
    const skills = await loadSkills(port);
    expect(skills.map((skill) => skill.name)).toEqual(["shout"]);
  });
});

describe("skillsExtension", () => {
  test("with no skills it adds no tools and no sections", () => {
    const extension = skillsExtension([], portOver({}));
    expect(extension.name).toBe(SKILLS_EXTENSION);
    expect(extension.tools ?? []).toEqual([]);
    expect(extension.sections ?? []).toEqual([]);
  });

  test("it adds the two tools and a catalog section", async () => {
    const port = portOver({ "shout/SKILL.md": SHOUT_MD });
    const extension = skillsExtension(await loadSkills(port), port);
    expect(extension.name).toBe(SKILLS_EXTENSION);
    expect(extension.tools?.map((tool) => tool.name)).toEqual([
      "activate_skill",
      "read_skill_resource",
    ]);
    const section = extension.sections?.[0];
    expect(section?.key).toBe("skills");
    expect(await section?.render(NO_INPUT, CONTEXT)).toBe(
      "Available skills. Use activate_skill to load one before you use it:\n- shout: Shouts the answer."
    );
  });

  test("activate_skill returns the SKILL.md text and the file list", async () => {
    const port = portOver({
      "shout/notes/a.md": NOTE_TEXT,
      "shout/SKILL.md": SHOUT_MD,
    });
    const extension = skillsExtension(await loadSkills(port), port);
    const result = await execute(extension, "activate_skill", {
      name: "shout",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(
      `---\nname: shout\ndescription: Shouts the answer.\n---\n${SHOUT_BODY}\n\nFiles: shout/notes/a.md`
    );
  });

  test("activate_skill says none when the skill has no other files", async () => {
    const port = portOver({ "shout/SKILL.md": SHOUT_MD });
    const extension = skillsExtension(await loadSkills(port), port);
    const result = await execute(extension, "activate_skill", {
      name: "shout",
    });
    expect(textOf(result).endsWith("\n\nFiles: none")).toBe(true);
  });

  test("activate_skill reads SKILL.md at call time", async () => {
    const files = { "shout/SKILL.md": SHOUT_MD };
    const port = portOver(files);
    const extension = skillsExtension(await loadSkills(port), port);
    files["shout/SKILL.md"] = SHOUT_MD.replace(SHOUT_BODY, "Edited body.");
    const result = await execute(extension, "activate_skill", {
      name: "shout",
    });
    expect(textOf(result)).toContain("Edited body.");
  });

  test("read_skill_resource returns the file as text", async () => {
    const port = portOver({
      "shout/notes/a.md": NOTE_TEXT,
      "shout/SKILL.md": SHOUT_MD,
    });
    const extension = skillsExtension(await loadSkills(port), port);
    const result = await execute(extension, "read_skill_resource", {
      path: "shout/notes/a.md",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(NOTE_TEXT);
  });

  test("read_skill_resource returns an error result when the port throws", async () => {
    const port = portOver({ "shout/SKILL.md": SHOUT_MD });
    const extension = skillsExtension(await loadSkills(port), port);
    const result = await execute(extension, "read_skill_resource", {
      path: "shout/missing.md",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("no such file: shout/missing.md");
  });
});

describe("skills through a real harness", () => {
  test("the model gets the activate_skill text back", async () => {
    const seen: string[] = [];
    const script = (context: TranscriptContext): AssistantMessage => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        seen.push(messageText(last.content));
        return fauxAssistantMessage([fauxText("done")]);
      }
      return fauxAssistantMessage(
        [fauxToolCall("activate_skill", { name: "shout" })],
        {
          stopReason: "toolUse",
        }
      );
    };
    const faux = fauxProvider();
    faux.setResponses([script, script]);
    const models = createModels();
    models.setProvider(faux.provider);

    const port = portOver({ "shout/SKILL.md": SHOUT_MD });
    const registry = createRegistry();
    registry.install(skillsExtension(await loadSkills(port), port));

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
    const submission = await root.submit(
      { content: "use the skill", type: "input" },
      BACKGROUND_CONTEXT
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);

    expect(settled.status).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(SHOUT_BODY);
    expect(seen[0]).toContain("Files: none");
  });
});
