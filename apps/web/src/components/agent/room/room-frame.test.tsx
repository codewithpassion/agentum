import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { RoomFrame } from "./room-frame.tsx";
import { ARCHIVED_NOTE } from "./section.tsx";
import { ROOM_TABS, type RoomTab } from "./tabs.ts";
import { fixtureRoom, renderInRoom } from "./test-fixtures.tsx";

// The Subagents switch and the connector panels read Clerk's auth state, which needs a provider.
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ orgRole: "org:admin", userId: "user_1" }),
}));

const noop = (): void => undefined;

const frame = (archived: boolean) => {
  const room = fixtureRoom();
  room.agent.status = archived ? "archived" : "active";
  room.profile.header.status = room.agent.status;
  const html = renderInRoom(
    <RoomFrame
      nowMs={null}
      onEdit={noop}
      onOpenMail={noop}
      onOpenTab={noop}
      onStarted={noop}
      room={room}
      tab="work"
    />
  );
  const { document } = new Window();
  document.body.innerHTML = html;
  return document;
};

test("the bar of an archived agent is outside the disabled fieldset, its header and panel are inside", () => {
  const document = frame(true);
  const tablist = document.querySelector('[role="tablist"]');
  const panel = document.querySelector('[role="tabpanel"]');
  expect(tablist).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(tablist?.closest("fieldset[disabled]")).toBeNull();
  expect(panel?.closest("fieldset[disabled]")).not.toBeNull();
  expect(
    document.querySelector("header")?.closest("fieldset[disabled]")
  ).not.toBeNull();
});

test("an active agent has nothing disabled", () => {
  const document = frame(false);
  expect(document.querySelector("fieldset[disabled]")).toBeNull();
});

const renderTab = (tab: RoomTab, archived: boolean) => {
  const room = fixtureRoom();
  room.agent.status = archived ? "archived" : "active";
  room.profile.header.status = room.agent.status;
  room.members = [
    { name: "Dev User", userId: "user_1" },
    { name: "Second", userId: "user_2" },
  ];
  const { document } = new Window();
  document.body.innerHTML = renderInRoom(
    <RoomFrame
      nowMs={null}
      onEdit={noop}
      onOpenMail={noop}
      onOpenTab={noop}
      onStarted={noop}
      room={room}
      tab={tab}
    />
  );
  return document;
};

const FORM_CONTROLS = "button, input, select, textarea";

/**
 * happy-dom's `:disabled` ignores fieldsets, so apply the HTML rule here. It
 * covers form controls only: its own attribute, or a disabled fieldset around it.
 */
const isDisabled = (control: {
  closest: (selector: string) => unknown;
  hasAttribute: (name: string) => boolean;
}): boolean =>
  control.hasAttribute("disabled") ||
  control.closest("fieldset[disabled]") !== null;

/** Links a fieldset cannot disable. On an archived agent they may only open read-only pages. */
const READ_ONLY_HREFS = ["/sessions", "/tasks/", "/threads/", "/settings"];

const TABS_WITH_PANELS = ["keys", "knows", "jobs", "settings"] as const;

test("every form control in an archived agent's tabs is disabled", () => {
  for (const tab of ROOM_TABS) {
    const panel = renderTab(tab, true).querySelector('[role="tabpanel"]');
    for (const control of panel?.querySelectorAll(FORM_CONTROLS) ?? []) {
      expect(isDisabled(control)).toBe(true);
    }
  }
  // The same selector finds enabled controls on an active agent, so the loop above is not empty.
  for (const tab of ["files", "knows"] as const) {
    const panel = renderTab(tab, false).querySelector('[role="tabpanel"]');
    const enabled = [...(panel?.querySelectorAll(FORM_CONTROLS) ?? [])].filter(
      (control) => !isDisabled(control)
    );
    expect(enabled.length).toBeGreaterThan(0);
  }
});

test("an archived agent's tabs link only to read-only pages", () => {
  for (const tab of ROOM_TABS) {
    const panel = renderTab(tab, true).querySelector('[role="tabpanel"]');
    for (const link of panel?.querySelectorAll("a[href]") ?? []) {
      const href = link.getAttribute("href") ?? "";
      expect(READ_ONLY_HREFS.some((prefix) => href.startsWith(prefix))).toBe(
        true
      );
    }
  }
});

test("an archived agent has no way into its home folder, no connect link and no instruction toggle", () => {
  const files = renderTab("files", true);
  expect(files.body.textContent).not.toContain("Open home folder");
  expect(renderTab("files", false).body.textContent).toContain(
    "Open home folder"
  );
  expect(
    renderTab("keys", true).querySelectorAll('a[href^="/connect"]')
  ).toHaveLength(0);
  const long = fixtureRoom();
  long.agent.status = "archived";
  long.profile.does = "x".repeat(400);
  const knows = new Window().document;
  knows.body.innerHTML = renderInRoom(
    <RoomFrame
      nowMs={null}
      onEdit={noop}
      onOpenMail={noop}
      onOpenTab={noop}
      onStarted={noop}
      room={long}
      tab="knows"
    />
  );
  expect(knows.body.textContent).not.toContain("Show more");
  expect(
    knows.querySelector('[data-testid="profile-does"]')?.className
  ).not.toContain("line-clamp");
});

test("an archived agent's Keys tab shows one note", () => {
  const text = renderTab("keys", true).body.textContent ?? "";
  expect(text.split(ARCHIVED_NOTE)).toHaveLength(2);
});

test("an archived agent's tabs show a note, not the panels that change it", () => {
  for (const tab of TABS_WITH_PANELS) {
    expect(renderTab(tab, true).body.textContent).toContain(ARCHIVED_NOTE);
    expect(renderTab(tab, false).body.textContent).not.toContain(ARCHIVED_NOTE);
  }
});

test("an archived agent's owner and backup cannot be changed", () => {
  // Radix selects open in a portal outside the fieldset, so they must not render at all.
  expect(
    renderTab("settings", false).querySelectorAll('[role="combobox"]').length
  ).toBeGreaterThanOrEqual(2);
  expect(
    renderTab("settings", true).querySelectorAll('[role="combobox"]')
  ).toHaveLength(0);
});
