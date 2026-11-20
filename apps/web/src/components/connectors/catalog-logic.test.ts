import { expect, test } from "bun:test";
import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { catalogEntriesToAdd } from "./catalog-logic.ts";

const entry = (name: string, key = name.toLowerCase()): CatalogEntry => ({
  authKind: "oauth",
  defaultAllowedTools: [],
  description: "",
  icon: "",
  key,
  name,
  url: "https://example.com/mcp",
});

const connector = (
  id: string,
  name: string,
  catalogKey: string | null = null
): ConnectorRecord =>
  ({
    catalogKey,
    headerTemplate: null,
    id,
    name,
    secretId: null,
  }) as ConnectorRecord;

test("an entry is left out when a connector came from it", () => {
  const entries = catalogEntriesToAdd(
    [entry("Gmail"), entry("Linear")],
    [connector("c1", "Mail", "gmail")]
  );
  expect(entries.map((item) => item.key)).toEqual(["linear"]);
});

test("an entry is left out when a connector has its name, ignoring case and surrounding spaces", () => {
  const entries = catalogEntriesToAdd(
    [entry("Linear"), entry("Gmail")],
    [connector("c1", "  LINEAR ")]
  );
  expect(entries.map((item) => item.name)).toEqual(["Gmail"]);
});

test("a connector with a different name and no catalogue key does not hide an entry", () => {
  const entries = catalogEntriesToAdd(
    [entry("Linear", "linear")],
    [connector("c1", "Linear Docs", "gmail")]
  );
  expect(entries.map((item) => item.key)).toEqual(["linear"]);
});

test("a null catalogue gives an empty list", () => {
  expect(catalogEntriesToAdd(null, [connector("c1", "Docs")])).toEqual([]);
});
