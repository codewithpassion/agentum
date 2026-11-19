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

const CONTROLS =
  'button, input, select, textarea, a[href], [role="combobox"], [role="switch"]';

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

const TABS_WITH_PANELS = ["keys", "knows", "jobs", "settings"] as const;

test("every control in an archived agent's tabs sits in the disabled fieldset", () => {
  for (const tab of ROOM_TABS) {
    const panel = renderTab(tab, true).querySelector('[role="tabpanel"]');
    for (const control of panel?.querySelectorAll(CONTROLS) ?? []) {
      expect(control.closest("fieldset[disabled]")).not.toBeNull();
    }
  }
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
