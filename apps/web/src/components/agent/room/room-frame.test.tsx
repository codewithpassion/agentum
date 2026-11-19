import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { RoomFrame } from "./room-frame.tsx";
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

test("an archived agent's tabs still switch, while its content is disabled", () => {
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

test("every control in an archived agent's Keys, Jobs, Knows and Files tabs sits in the disabled fieldset", () => {
  for (const tab of ["keys", "jobs", "knows", "files", "settings"] as const) {
    const room = fixtureRoom();
    room.agent.status = "archived";
    room.profile.header.status = "archived";
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
    const panel = document.querySelector('[role="tabpanel"]');
    const controls = [
      ...(panel?.querySelectorAll("button, input, select, textarea") ?? []),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.closest("fieldset[disabled]")).not.toBeNull();
    }
  }
});
