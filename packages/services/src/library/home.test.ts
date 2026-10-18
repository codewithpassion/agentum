import { expect, test } from "bun:test";
import { ServiceError } from "../errors.ts";
import { agentHomePath, ensureAgentHome, type HomeOps } from "./home.ts";

const fakeLibrary = () => {
  const folders = new Set<string>();
  const made: string[] = [];
  const ops: HomeOps = {
    mkdir: (path) => {
      made.push(path);
      folders.add(path);
      return Promise.resolve();
    },
    stat: (path) =>
      folders.has(path)
        ? Promise.resolve()
        : Promise.reject(new ServiceError("not_found", "Not found")),
  };
  return { made, ops };
};

test("the home of an agent is agents/<slug>", () => {
  expect(agentHomePath("ada")).toBe("agents/ada");
});

test("a missing home is made once, and a second call leaves it alone", async () => {
  const { made, ops } = fakeLibrary();

  await ensureAgentHome(ops, "ada");
  await ensureAgentHome(ops, "ada");

  expect(made).toEqual(["agents/ada"]);
});

test("an error other than not found is not swallowed", async () => {
  const ops: HomeOps = {
    mkdir: () => Promise.resolve(),
    stat: () => Promise.reject(new ServiceError("conflict", "No")),
  };

  await expect(ensureAgentHome(ops, "ada")).rejects.toThrow("No");
});
