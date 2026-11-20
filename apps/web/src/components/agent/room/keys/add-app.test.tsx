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
      disabled={false}
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
      disabled={false}
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
      disabled={false}
      isAdmin={false}
      onAdded={noop}
    />
  );
  expect(html).toContain("Gmail (admin only)");
});

// renderToStaticMarkup escapes the apostrophe.
const LOCKED_NOTE =
  "Only the agent&#x27;s owners and admins can change its apps.";
const DISABLED_ATTR = /\sdisabled=""/;
const APP_PICKER = /<select[^>]*aria-label="App to add"[^>]*>/;
const ADD_BUTTON = /<button[^>]*>Add app<\/button>/;
/** A disabled control has the attribute; Tailwind's `disabled:` classes do not count. */
const isDisabled = (tag: string | undefined): boolean =>
  tag !== undefined && DISABLED_ATTR.test(tag);

const renderAddApp = (disabled: boolean): string =>
  renderInRoom(
    <AddApp
      agentId="agent_1"
      assignedIds={new Set()}
      catalog={[entry]}
      connectors={[]}
      disabled={disabled}
      isAdmin={false}
      onAdded={noop}
    />
  );

test("disabled turns off the app picker and the add button and says who can change the apps", () => {
  const html = renderAddApp(true);
  const select = html.match(APP_PICKER)?.[0];
  const add = html.match(ADD_BUTTON)?.[0];
  expect(isDisabled(select)).toBe(true);
  expect(isDisabled(add)).toBe(true);
  expect(html).toContain(LOCKED_NOTE);
});

test("enabled leaves the app picker on and hides the note", () => {
  const html = renderAddApp(false);
  const select = html.match(APP_PICKER)?.[0];
  expect(isDisabled(select)).toBe(false);
  expect(html).not.toContain(LOCKED_NOTE);
});
