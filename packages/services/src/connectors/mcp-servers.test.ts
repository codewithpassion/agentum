import { describe, expect, test } from "bun:test";
import { buildMcpServers } from "./mcp-servers.ts";

const PLATFORM = "https://hm.example";
const TOKEN = "hm_run_abc";

const build = (
  connectors: { id: string; name: string }[],
  platformUrl = PLATFORM
) => buildMcpServers({ connectors, platformUrl, runToken: TOKEN });

const keysOf = (connectors: { id: string; name: string }[]) =>
  Object.keys(build(connectors));

describe("buildMcpServers", () => {
  test("puts the harbourmaster entry first with the MCP url and run token", () => {
    const servers = build([]);

    expect(Object.keys(servers)).toEqual(["harbourmaster"]);
    expect(servers.harbourmaster).toEqual({
      headers: { Authorization: `Bearer ${TOKEN}` },
      type: "http",
      url: "https://hm.example/mcp",
    });
  });

  test("adds a proxy entry per connector, in the order given", () => {
    const servers = build([
      { id: "c1", name: "Linear" },
      { id: "c2", name: "GitHub" },
    ]);

    expect(Object.keys(servers)).toEqual(["harbourmaster", "linear", "github"]);
    expect(servers.linear).toEqual({
      headers: { Authorization: `Bearer ${TOKEN}` },
      type: "http",
      url: "https://hm.example/api/proxy/c1",
    });
    expect(servers).toMatchObject({
      github: { url: "https://hm.example/api/proxy/c2" },
    });
  });

  test("slugs names to lowercase runs of a-z0-9 joined by one dash", () => {
    expect(keysOf([{ id: "c", name: "  Linear -- Issues!! " }])).toEqual([
      "harbourmaster",
      "linear-issues",
    ]);
    expect(keysOf([{ id: "c", name: "my_tool.v2" }])).toEqual([
      "harbourmaster",
      "my-tool-v2",
    ]);
  });

  test("cuts a slug to 40 characters", () => {
    const name = `${"a".repeat(50)}`;

    expect(keysOf([{ id: "c", name }])).toEqual([
      "harbourmaster",
      "a".repeat(40),
    ]);
  });

  test("falls back to connector when nothing is left", () => {
    expect(keysOf([{ id: "c", name: "" }])).toEqual([
      "harbourmaster",
      "connector",
    ]);
    expect(keysOf([{ id: "c", name: "!!! ---" }])).toEqual([
      "harbourmaster",
      "connector",
    ]);
  });

  test("gives a connector named harbourmaster the -2 suffix", () => {
    const servers = build([{ id: "c1", name: "HarbourMaster" }]);

    expect(Object.keys(servers)).toEqual(["harbourmaster", "harbourmaster-2"]);
    expect(servers).toMatchObject({
      "harbourmaster-2": { url: "https://hm.example/api/proxy/c1" },
    });
  });

  test("numbers same-named connectors until the key is free", () => {
    expect(
      keysOf([
        { id: "c1", name: "GitHub" },
        { id: "c2", name: "github" },
        { id: "c3", name: "GITHUB!" },
      ])
    ).toEqual(["harbourmaster", "github", "github-2", "github-3"]);
  });

  test("skips a suffix that another connector already holds", () => {
    expect(
      keysOf([
        { id: "c1", name: "docs-2" },
        { id: "c2", name: "docs" },
        { id: "c3", name: "docs" },
      ])
    ).toEqual(["harbourmaster", "docs-2", "docs", "docs-3"]);
  });

  test("strips a trailing slash from the platform url", () => {
    const servers = build(
      [{ id: "c1", name: "Linear" }],
      "https://hm.example//"
    );

    expect(servers).toMatchObject({
      harbourmaster: { url: "https://hm.example/mcp" },
      linear: { url: "https://hm.example/api/proxy/c1" },
    });
  });
});
