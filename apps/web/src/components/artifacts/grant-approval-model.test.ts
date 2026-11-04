import { expect, test } from "bun:test";
import type { ApprovalDisplay } from "@repo/protocol/requests";
import { decideAll, parsePromoteApproval } from "./grant-approval-model.ts";

const display = (
  overrides: Partial<ApprovalDisplay> = {}
): ApprovalDisplay => ({
  input: {
    artifactId: "a1",
    grants: [
      { id: "g1", kind: "tool", target: "gmail_send" },
      { id: "g2", kind: "tool", target: 'gmail_send#{"to":"x"}' },
      { id: "g3", kind: "tool", target: "gmail_send" },
      { id: "g4", kind: "host", target: "api.example.com" },
      { id: "g5", kind: "secret", target: "API_KEY" },
    ],
    query: "q",
    title: "Tracker",
    version: 3,
    versionId: "v3",
  },
  summary: "s",
  toolKey: "harbourmaster/artifact_promote",
  toolName: "artifact_promote",
  ...overrides,
});

test("parsePromoteApproval reads the lists and keeps limit rows only as ids", () => {
  expect(parsePromoteApproval(display())).toEqual({
    agents: [],
    artifactId: "a1",
    endpoints: [],
    grantIds: ["g1", "g2", "g3", "g4", "g5"],
    hosts: ["api.example.com"],
    secrets: ["API_KEY"],
    title: "Tracker",
    tools: ["gmail_send"],
    version: 3,
    versionId: "v3",
  });
});

test("parsePromoteApproval returns null for other tools and bad input", () => {
  expect(parsePromoteApproval(display({ toolName: "bash" }))).toBeNull();
  expect(parsePromoteApproval(display({ toolKey: "other/x" }))).toBeNull();
  expect(
    parsePromoteApproval(display({ input: { artifactId: "a1" } }))
  ).toBeNull();
});

test("decideAll decides every grant in order", async () => {
  const calls: string[] = [];
  await decideAll(["a", "b"], "approved", (id, decision) => {
    calls.push(`${id}:${decision}`);
    return Promise.resolve();
  });
  expect(calls).toEqual(["a:approved", "b:approved"]);
});

test("decideAll skips an already decided grant and stops at another error", async () => {
  const calls: string[] = [];
  await decideAll(["a", "b"], "rejected", (id) => {
    calls.push(id);
    return id === "a"
      ? Promise.reject(new Error("Grant already decided"))
      : Promise.resolve();
  });
  expect(calls).toEqual(["a", "b"]);

  const seen: string[] = [];
  await expect(
    decideAll(["a", "b", "c"], "approved", (id) => {
      seen.push(id);
      return id === "b" ? Promise.reject(new Error("boom")) : Promise.resolve();
    })
  ).rejects.toThrow("boom");
  expect(seen).toEqual(["a", "b"]);
});

test("endpoint and agent grants parse and are all approved", async () => {
  const parsed = parsePromoteApproval(
    display({
      input: {
        artifactId: "a1",
        grants: [
          { id: "endpoint", kind: "endpoint", target: "discord" },
          {
            id: "agent",
            kind: "agent",
            name: "Support bot",
            target: "agent_1",
          },
        ],
        title: "Bot",
        version: 1,
        versionId: "v1",
      },
    })
  );
  if (parsed === null) {
    throw new Error("Expected an app promotion approval");
  }
  expect(parsed).toMatchObject({
    agents: ["Support bot"],
    endpoints: ["discord"],
  });
  const calls: string[] = [];
  await decideAll(parsed.grantIds, "approved", (id, decision) => {
    calls.push(`${id}:${decision}`);
    return Promise.resolve();
  });
  expect(calls).toEqual(["endpoint:approved", "agent:approved"]);
});
