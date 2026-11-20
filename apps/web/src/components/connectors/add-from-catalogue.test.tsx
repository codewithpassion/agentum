import { expect, test } from "bun:test";
import type { CatalogEntry } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { AddFromCatalogue } from "./add-from-catalogue.tsx";

const noop = (): void => undefined;
const entry = {
  authKind: "oauth",
  defaultAllowedTools: ["create_issue"],
  description: "Issue tracking",
  icon: "linear",
  key: "linear",
  name: "Linear",
  url: "https://example.com/mcp",
} satisfies CatalogEntry;

const connector = (catalogKey: string | null): ConnectorRecord =>
  ({
    catalogKey,
    headerTemplate: null,
    id: "c1",
    name: "Workspace Linear",
    secretId: null,
  }) as ConnectorRecord;

test("the section lists catalogue apps and labels the picker", () => {
  const html = renderToStaticMarkup(
    <AddFromCatalogue catalog={[entry]} connectors={[]} onAdded={noop} />
  );
  expect(html).toContain("Add from the catalogue");
  expect(html).toContain("From the catalogue");
  expect(html).toContain("Linear");
  expect(html).toContain('aria-label="App to add"');
});

test("an entry the workspace already has as a connector renders nothing", () => {
  const html = renderToStaticMarkup(
    <AddFromCatalogue
      catalog={[entry]}
      connectors={[connector("linear")]}
      onAdded={noop}
    />
  );
  expect(html).toBe("");
});

test("a null catalogue renders nothing", () => {
  const html = renderToStaticMarkup(
    <AddFromCatalogue catalog={null} connectors={[]} onAdded={noop} />
  );
  expect(html).toBe("");
});
