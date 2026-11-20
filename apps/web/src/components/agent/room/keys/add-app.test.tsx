import { expect, test } from "bun:test";
import type { CatalogEntry } from "@repo/db/shared";
import { renderInRoom } from "../test-fixtures.tsx";
import { AddApp } from "./add-app.tsx";

const noop = (): void => undefined;
const entry = {
  authKind: "oauth",
  defaultAllowedTools: ["search_threads"],
  description: "Mail",
  icon: "mail",
  key: "gmail",
  name: "Gmail",
  url: "https://example.com/mcp",
} satisfies CatalogEntry;

test("the menu lists catalogue apps for an admin and says when there is nothing to add", () => {
  const withEntry = renderInRoom(
    <AddApp
      agentId="agent_1"
      assignedIds={new Set()}
      catalog={[entry]}
      connectors={[]}
      isAdmin
      onAdded={noop}
    />
  );
  expect(withEntry).toContain("Add an app");
  expect(withEntry).toContain("From the catalogue");
  expect(withEntry).toContain("Gmail");
  const empty = renderInRoom(
    <AddApp
      agentId="agent_1"
      assignedIds={new Set()}
      catalog={[]}
      connectors={[]}
      isAdmin
      onAdded={noop}
    />
  );
  expect(empty).toContain("There is no other app to add.");
});

test("a member sees catalogue apps as admin only", () => {
  const html = renderInRoom(
    <AddApp
      agentId="agent_1"
      assignedIds={new Set()}
      catalog={[entry]}
      connectors={[]}
      isAdmin={false}
      onAdded={noop}
    />
  );
  expect(html).toContain("Gmail (admin only)");
});
