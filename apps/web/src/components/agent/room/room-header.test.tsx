import { expect, test } from "bun:test";
import { RoomHeader } from "./room-header.tsx";
import { fixtureRoom, renderInRoom } from "./test-fixtures.tsx";

const noop = (): void => undefined;
const render = (room = fixtureRoom()) =>
  renderInRoom(
    <RoomHeader onEdit={noop} onOpenMail={noop} onStarted={noop} room={room} />
  );

test("the header shows name, job line, owner and where the agent runs", () => {
  const html = render();
  expect(html).toContain("Sorter");
  expect(html).toContain("Sort the inbox every morning.");
  expect(html).toContain("Owner: Dev User");
  expect(html).toContain("Runs on Cloud");
  expect(html).toContain("Run now");
});

test("an archived agent has no Edit or Run now", () => {
  const room = fixtureRoom();
  room.profile.header.status = "archived";
  const html = render(room);
  expect(html).toContain("Archived");
  expect(html).not.toContain("Run now");
});
