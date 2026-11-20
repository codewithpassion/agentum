import { beforeEach, expect, mock, test } from "bun:test";
import { fixtureRoom, renderInRoom } from "./test-fixtures.tsx";

// The header reads Clerk's auth state to decide who may reserve an address or set up mail.
let current = { orgRole: "org:admin", userId: "user_1" };
mock.module("@clerk/tanstack-react-start", () => ({
  useAuth: () => current,
}));

const { RoomHeader } = await import("./room-header.tsx");

beforeEach(() => {
  current = { orgRole: "org:admin", userId: "user_1" };
});

const noop = (): void => undefined;
const render = (room = fixtureRoom()) =>
  renderInRoom(
    <RoomHeader onEdit={noop} onOpenMail={noop} onStarted={noop} room={room} />
  );

const withAddress = () => {
  const room = fixtureRoom();
  room.profile.header.emailLocal = "sorter";
  return room;
};

const failedMailbox = (): NonNullable<
  ReturnType<typeof fixtureRoom>["mailbox"]
> => ({
  address: "sorter@agentum.example",
  agentId: "agent_1",
  createdAt: "2026-11-02T00:00:00.000Z",
  id: "mbx_1",
  lastError: "Provider rejected the domain",
  routingRuleId: null,
  status: "failed",
  triggerDisabledAt: null,
  workspaceId: "ws_1",
});

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

test("an admin reserves an address when there is none", () => {
  current = { orgRole: "org:admin", userId: "user_2" };
  const html = render();
  expect(html).toContain("Reserve an address");
  expect(html).not.toContain("No address yet");
});

test("the owner reserves an address when there is none", () => {
  current = { orgRole: "org:member", userId: "user_1" };
  expect(render()).toContain("Reserve an address");
});

test("an admin sets up mail when the address is set but there is no mailbox", () => {
  current = { orgRole: "org:admin", userId: "user_2" };
  expect(render(withAddress())).toContain("Set up mail");
});

test("the owner sets up mail when the address is set but there is no mailbox", () => {
  current = { orgRole: "org:member", userId: "user_1" };
  expect(render(withAddress())).toContain("Set up mail");
});

test("a plain member sees no reserve button and says there is no address yet", () => {
  current = { orgRole: "org:member", userId: "user_other" };
  const html = render();
  expect(html).toContain("No address yet");
  expect(html).not.toContain("Reserve an address");
  expect(html).not.toContain("Set up mail");
});

test("a plain member sees the address but no set up button when there is no mailbox", () => {
  current = { orgRole: "org:member", userId: "user_other" };
  const html = render(withAddress());
  expect(html).toContain("sorter");
  expect(html).not.toContain("Set up mail");
});

test("a plain member sees a failed mailbox's address and status but no retry", () => {
  current = { orgRole: "org:member", userId: "user_other" };
  const room = withAddress();
  room.mailbox = failedMailbox();
  const html = render(room);
  expect(html).toContain("sorter@agentum.example");
  expect(html).toContain("Failed");
  expect(html).not.toContain("Retry");
  expect(html).not.toContain("Try again");
  expect(html).not.toContain("Set up mail");
});

test("an admin sees the retry for a failed mailbox", () => {
  current = { orgRole: "org:admin", userId: "user_2" };
  const room = withAddress();
  room.mailbox = failedMailbox();
  expect(render(room)).toContain("Retry");
});
