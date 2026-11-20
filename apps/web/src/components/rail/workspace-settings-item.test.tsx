import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceSettingsItem } from "./workspace-menu.tsx";
import { isActiveAdmin } from "./workspace-menu-logic.ts";

const noop = () => undefined;

test("non-admins get no Settings workspace menu item", () => {
  const admin = isActiveAdmin({
    activeOrgId: "org",
    mine: [{ clerkOrgId: "org", role: "org:member", workspaceId: "ws" }],
  });
  expect(admin).toBe(false);
  expect(
    renderToStaticMarkup(
      <WorkspaceSettingsItem admin={admin} onSelect={noop} />
    )
  ).toBe("");
});
