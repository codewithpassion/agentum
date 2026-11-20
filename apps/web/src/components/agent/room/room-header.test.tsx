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

test("a weekly limit shows this week's spend against it", () => {
  const room = fixtureRoom();
  room.spend = { capCents: 2000, paused: false, weekCents: 410 };
  const html = render(room);
  expect(html).toContain("$4.10 of $20 this week");
  expect(html).not.toContain("Paused");
});

test("no limit shows no spend line, and a pause says so", () => {
  const room = fixtureRoom();
  expect(render(room)).not.toContain("this week");
  room.spend = { capCents: 500, paused: true, weekCents: 500 };
  expect(render(room)).toContain("Paused. Weekly limit reached");
});
