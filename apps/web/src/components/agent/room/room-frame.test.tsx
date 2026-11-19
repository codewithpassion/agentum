import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { RoomFrame } from "./room-frame.tsx";
import { fixtureRoom, renderInRoom } from "./test-fixtures.tsx";

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
