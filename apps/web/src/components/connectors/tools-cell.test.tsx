import { expect, test } from "bun:test";
import type { CatalogEntry } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { ToolsCell } from "./tools-cell.tsx";

type Connector = Pick<
  ConnectorRecord,
  "catalogKey" | "tools" | "toolsFetchedAt"
>;

const tool = (name: string): ConnectorRecord["tools"][number] => ({
  description: null,
  name,
  readOnly: false,
});

const entry = (overrides: Partial<CatalogEntry>): CatalogEntry => ({
  authKind: "oauth",
  defaultAllowedTools: [],
  description: "",
  icon: "",
  key: "docs",
  name: "Docs",
  url: "https://example.test/mcp",
  ...overrides,
});

const FETCHED_AT = "2026-11-01T00:00:00.000Z";

const cachedConnector: Connector = {
  catalogKey: null,
  tools: [tool("search"), tool("fetch")],
  toolsFetchedAt: FETCHED_AT,
};

test("a connector with a cached tool list shows the count and the names", () => {
  const html = renderToStaticMarkup(
    <ToolsCell catalog={null} connector={cachedConnector} />
  );
  expect(html).toContain(">2</span>");
  expect(html).toContain('title="search, fetch">search, fetch</span>');
  expect(html).not.toContain("Not fetched yet");
});

test("a catalogue connector with no cached tools shows its default tools as allowed", () => {
  const html = renderToStaticMarkup(
    <ToolsCell
      catalog={[entry({ defaultAllowedTools: ["a", "b", "c"], key: "docs" })]}
      connector={{ catalogKey: "docs", tools: [], toolsFetchedAt: null }}
    />
  );
  expect(html).toContain(">3 by default</span>");
  expect(html).toContain(">Tool list not fetched yet</span>");
  expect(html).toContain('title="a, b, c">a, b, c</span>');
});

test("a catalogue connector with no cached tools and no catalogue shows Not fetched yet", () => {
  const html = renderToStaticMarkup(
    <ToolsCell
      catalog={null}
      connector={{ catalogKey: "docs", tools: [], toolsFetchedAt: null }}
    />
  );
  expect(html).toContain(">Not fetched yet</span>");
  expect(html).not.toContain("allowed");
});

test("a non-catalogue connector with no cached tools still shows 0", () => {
  const html = renderToStaticMarkup(
    <ToolsCell
      catalog={null}
      connector={{ catalogKey: null, tools: [], toolsFetchedAt: null }}
    />
  );
  expect(html).toContain(">0</span>");
  expect(html).not.toContain("Not fetched yet");
});

test("a catalogue connector fetched with no tools shows 0, not the defaults", () => {
  const html = renderToStaticMarkup(
    <ToolsCell
      catalog={[entry({ defaultAllowedTools: ["a"], key: "docs" })]}
      connector={{ catalogKey: "docs", tools: [], toolsFetchedAt: FETCHED_AT }}
    />
  );
  expect(html).toContain(">0</span>");
  expect(html).not.toContain("by default");
});
