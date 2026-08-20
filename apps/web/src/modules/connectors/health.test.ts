import { describe, expect, test } from "bun:test";
import { connectorsFailingAuth } from "./health";
import type { Connector } from "./schema";
import { connectorServerName } from "./usability";

const linear = {
  id: "11111111-2222-3333-4444-555555555555",
  url: "https://mcp.linear.app/mcp",
} as Connector;

const docs = {
  id: "99999999-8888-7777-6666-555555555555",
  url: "https://docs.example.com/mcp",
} as Connector;

const attached = [linear, docs];
const blamed = (message: string) =>
  connectorsFailingAuth(message, attached).map((connector) => connector.id);

describe("connectorsFailingAuth", () => {
  test("matches the server name we registered", () => {
    expect(
      blamed(`MCP server ${connectorServerName(linear)} returned 401`)
    ).toEqual([linear.id]);
  });

  test("matches the server URL", () => {
    expect(blamed("Unauthorized calling https://mcp.linear.app/mcp")).toEqual([
      linear.id,
    ]);
  });

  test("matches the host on its own", () => {
    expect(
      blamed("tool call failed: mcp.linear.app rejected the access token")
    ).toEqual([linear.id]);
  });

  test("blames only the connector the error names", () => {
    expect(blamed("mcp.linear.app: invalid_token")).toEqual([linear.id]);
  });

  test("ignores an error about a connector that mentions no auth failure", () => {
    // A connector can time out or return a malformed tool result without its
    // credentials being at fault; flipping its status would be a lie.
    expect(blamed("mcp.linear.app timed out after 30s")).toEqual([]);
  });

  test("ignores an auth failure that names no connector", () => {
    expect(blamed("401 from the model provider")).toEqual([]);
    expect(blamed("the session was terminated: budget exhausted")).toEqual([]);
  });

  test("can blame more than one connector across a page of errors", () => {
    const ids = ["mcp.linear.app: 401", "docs.example.com: 403"].flatMap(
      (message) => blamed(message)
    );

    expect(ids).toEqual([linear.id, docs.id]);
  });
});
