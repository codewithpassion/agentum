import { describe, expect, test } from "bun:test";
import { CLOUD_MODELS, type CloudModel } from "@repo/services/cloud/models";
import { createCloudModels } from "./pi-run-models.ts";

// The registry a run uses: pi-ai's bundled OpenRouter list plus the entries
// `pi-run-models.ts` defines itself. A catalogue id missing from it makes Pi
// fail the run with a bare `no_model`.
const models = createCloudModels({
  delete: () => Promise.resolve(),
  list: () => Promise.resolve([]),
  modify: () => Promise.reject(new Error("read only")),
  read: () => Promise.resolve(undefined),
});

const openRouterModels: readonly CloudModel[] = CLOUD_MODELS.filter(
  (model) => model.provider === "openrouter"
);

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("CLOUD_MODELS against the Pi model registry", () => {
  test("has openrouter entries to check", () => {
    expect(openRouterModels.length).toBeGreaterThan(0);
  });

  test.each(openRouterModels)("the registry lists $id", (model) => {
    const piModel = models.getModel("openrouter", model.id);
    expect(piModel).toBeDefined();
    expect(piModel?.id).toBe(model.id);
  });

  test.each(openRouterModels)("$id input matches the registry", (model) => {
    const piModel = models.getModel("openrouter", model.id);
    expect(piModel).toBeDefined();
    expect(sorted(piModel?.input ?? [])).toEqual(sorted(model.input));
  });
});
