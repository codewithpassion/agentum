import { expect, test } from "bun:test";
import type { MachineRecord } from "#/integrations/trpc/types";
import {
  hostMachines,
  MOVE_COST,
  MOVE_TARGETS,
  moveBlocker,
  moveNote,
  needsAnthropicModel,
} from "./move-agent-logic.ts";

const machine = (overrides: Partial<MachineRecord>): MachineRecord =>
  ({
    id: "m1",
    roles: ["agent_host"],
    status: "online",
    ...overrides,
  }) as MachineRecord;

test("MOVE_TARGETS are named with the plain runtime names, in order", () => {
  expect(MOVE_TARGETS.map((target) => target.title)).toEqual([
    "Cloud",
    "Anthropic cloud",
    "My computer",
  ]);
});

test("MOVE_COST and the Cloud note avoid the word runtime", () => {
  expect(MOVE_COST).not.toContain("runtime");
  expect(MOVE_COST).toBe(
    "Open conversations start fresh, because the agent will run somewhere that does not have their context. Files in the agent's sandbox do not move."
  );
  expect(
    moveNote("cloud")?.startsWith("A conversation that ran on Cloud before")
  ).toBe(true);
});

test("hostMachines keeps agent_host machines that are not revoked", () => {
  const hosts = hostMachines([
    machine({ id: "a" }),
    machine({ id: "b", roles: ["computer"] }),
    machine({ id: "c", status: "revoked" }),
  ]);
  expect(hosts.map((host) => host.id)).toEqual(["a"]);
});

test("managed without a key is blocked, and the fix is the model providers page", () => {
  const blocker = moveBlocker({
    hasAnthropicKey: false,
    hosts: [],
    target: "managed",
  });
  expect(blocker).toMatchObject({
    fix: { to: "/settings/model-providers" },
    text: expect.stringContaining("Anthropic API key"),
  });
  expect(
    moveBlocker({ hasAnthropicKey: true, hosts: [], target: "managed" })
  ).toBeNull();
});

test("a machine target without a host is blocked, and the fix is the machines page", () => {
  const blocker = moveBlocker({
    hasAnthropicKey: true,
    hosts: [],
    target: "machine",
  });
  expect(blocker).toMatchObject({ fix: { to: "/settings/machines" } });
  expect(
    moveBlocker({
      hasAnthropicKey: false,
      hosts: [machine({})],
      target: "machine",
    })
  ).toBeNull();
});

test("cloud has no blocker and takes any model", () => {
  expect(
    moveBlocker({ hasAnthropicKey: false, hosts: [], target: "cloud" })
  ).toBeNull();
  expect(needsAnthropicModel("cloud", "openrouter:z-ai/glm-5.3")).toBe(false);
  expect(needsAnthropicModel("managed", "openrouter:z-ai/glm-5.3")).toBe(true);
  expect(needsAnthropicModel("machine", "claude-sonnet-5-5")).toBe(false);
});
