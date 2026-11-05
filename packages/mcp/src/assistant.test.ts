import { expect, test } from "bun:test";
import { assistantTools, secretCardSchema } from "./assistant";
import type { McpPorts } from "./ports";
import { agentumTools } from "./server";

const unused = () => Promise.reject(new Error("unused"));
const DEVICE_TOOL = /^(computer|browser)_/;
const fakePorts = new Proxy(
  { admin: new Proxy({}, { get: () => unused }) },
  { get: (target, key) => (key === "admin" ? target.admin : unused) }
) as unknown as McpPorts;

test("assistant tools admit member management and admin secret cards only", () => {
  for (const isAdmin of [false, true]) {
    const names = assistantTools(fakePorts, isAdmin).map((tool) => tool.name);
    for (const name of [
      "create_agent",
      "update_agent",
      "archive_agent",
      "send_message",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of [
      "grant_secret",
      "revoke_secret",
      "request_secret",
      "request_model_key",
    ]) {
      expect(names.includes(name)).toBe(isAdmin);
    }
    for (const name of [
      "create_secret",
      "create_api_key",
      "revoke_api_key",
      "create_enrolment_code",
      "delete_connector",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(names.some((name) => DEVICE_TOOL.test(name))).toBe(false);
  }
});

test("assistant construction leaves the session MCP tool list unchanged", () => {
  const before = agentumTools(fakePorts).map((tool) => tool.name);
  assistantTools(fakePorts, true);
  expect(agentumTools(fakePorts).map((tool) => tool.name)).toEqual(before);
  expect(before).not.toContain("request_secret");
});

test("secret cards accept the lowercase names supported by secrets.create", () => {
  expect(
    secretCardSchema.safeParse({
      mode: "env",
      name: "github_token",
      reason: "GitHub access",
    }).success
  ).toBe(true);
});
