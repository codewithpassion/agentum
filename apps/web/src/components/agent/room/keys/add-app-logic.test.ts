import { expect, test } from "bun:test";
import type { CatalogEntry } from "@repo/db/shared";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import {
  addChoices,
  catalogAllowedTools,
  choiceValue,
} from "./add-app-logic.ts";

const entry = (name: string, tools: string[] = ["a"]): CatalogEntry => ({
  authKind: "oauth",
  defaultAllowedTools: tools,
  description: "",
  icon: "",
  key: name.toLowerCase(),
  name,
  url: "https://example.com/mcp",
});

const connector = (
  id: string,
  name: string,
  secretId: string | null = null,
  catalogKey: string | null = null
): ConnectorRecord =>
  ({ catalogKey, headerTemplate: null, id, name, secretId }) as ConnectorRecord;

const none = new Set<string>();

test("a catalogue entry the workspace already has as a connector is listed once", () => {
  const choices = addChoices({
    assignedIds: none,
    catalog: [entry("Gmail"), entry("Linear")],
    connectors: [connector("c1", "gmail")],
    isAdmin: true,
  });
  expect(choices.map(choiceValue)).toEqual(["catalog:linear", "connector:c1"]);
});

test("a connector the agent already has is not offered again", () => {
  const choices = addChoices({
    assignedIds: new Set(["c1"]),
    catalog: [],
    connectors: [connector("c1", "Gmail"), connector("c2", "Docs")],
    isAdmin: true,
  });
  expect(choices.map(choiceValue)).toEqual(["connector:c2"]);
});

test("a member cannot add from the catalogue or add an app on a workspace secret", () => {
  const choices = addChoices({
    assignedIds: none,
    catalog: [entry("Linear")],
    connectors: [connector("c1", "Docs"), connector("c2", "Stripe", "s1")],
    isAdmin: false,
  });
  expect(choices.map((choice) => choice.disabled)).toEqual([true, false, true]);
  expect(choices[0]?.label).toBe("Linear (admin only)");
});

test("an entry with no default tools gives every tool", () => {
  expect(catalogAllowedTools(entry("Gmail", []))).toBeUndefined();
  expect(catalogAllowedTools(entry("Gmail", ["a", "b"]))).toEqual(["a", "b"]);
});

test("a catalogue connector the workspace already has is added with the entry's default tools", () => {
  const [choice] = addChoices({
    assignedIds: none,
    catalog: [entry("Gmail", ["search_threads"])],
    connectors: [connector("c1", "Mail", null, "gmail")],
    isAdmin: false,
  });
  expect(choice?.kind).toBe("connector");
  expect(choice?.kind === "connector" ? choice.allowedTools : null).toEqual([
    "search_threads",
  ]);
});

test("a custom connector is added with every tool", () => {
  const [choice] = addChoices({
    assignedIds: none,
    catalog: [],
    connectors: [connector("c1", "Docs")],
    isAdmin: true,
  });
  expect(
    choice?.kind === "connector" ? choice.allowedTools : null
  ).toBeUndefined();
});

test("without the catalogue, a catalogue connector cannot be added but a custom one can", () => {
  const choices = addChoices({
    assignedIds: none,
    catalog: null,
    connectors: [
      connector("c1", "Mail", null, "gmail"),
      connector("c2", "Docs"),
    ],
    isAdmin: true,
  });
  expect(choices.map((choice) => choice.disabled)).toEqual([true, false]);
  expect(choices[0]?.label).toContain("catalogue unavailable");
});
