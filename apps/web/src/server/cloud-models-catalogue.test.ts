import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { CLOUD_MODELS, type CloudModel } from "@repo/services/cloud/models";
import { file, resolveSync } from "bun";

interface PiChatModel {
  id: string;
  input: string[];
}

interface PiCatalogue {
  "openai-completions": Record<string, PiChatModel>;
}

const PI_AI_PACKAGE = resolveSync(
  "@earendil-works/pi-ai/package.json",
  import.meta.dir
);
const catalogue: PiCatalogue = await file(
  join(dirname(PI_AI_PACKAGE), "dist/providers/data/openrouter.json")
).json();
const chatModels = catalogue["openai-completions"];

const openRouterModels: readonly CloudModel[] = CLOUD_MODELS.filter(
  (model) => model.provider === "openrouter"
);

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("CLOUD_MODELS against the pi-ai catalogue", () => {
  test("has openrouter entries to check", () => {
    expect(openRouterModels.length).toBeGreaterThan(0);
  });

  test.each(openRouterModels)("pi-ai lists $id", (model) => {
    const piModel = chatModels[`chat:${model.id}`];
    expect(piModel).toBeDefined();
    expect(piModel?.id).toBe(model.id);
  });

  test.each(openRouterModels)("$id input matches pi-ai", (model) => {
    const piModel = chatModels[`chat:${model.id}`];
    expect(piModel).toBeDefined();
    expect(sorted(piModel?.input ?? [])).toEqual(sorted(model.input));
  });

  test("leaves out deepseek/deepseek-v4.1-flash-1017", () => {
    const id = "deepseek/deepseek-v4.1-flash-1017";
    expect(chatModels[`chat:${id}`]).toBeUndefined();
    expect(CLOUD_MODELS.map((model) => model.id)).not.toContain(id);
  });
});
