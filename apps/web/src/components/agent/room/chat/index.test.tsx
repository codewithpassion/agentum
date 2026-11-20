import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { ChatTab } from "./index.tsx";

test("Chat shows the conversation list and opens the main conversation", () => {
  const html = renderInRoom(<ChatTab {...fixtureTabProps()} />);
  expect(html).toContain("Conversations");
  expect(html).toContain("No conversations yet.");
  expect(html).toContain("Opening the conversation.");
});

test("an archived agent takes no new messages", () => {
  const props = fixtureTabProps();
  props.room.agent.status = "archived";
  const html = renderInRoom(<ChatTab {...props} />);
  expect(html).toContain("This agent is archived");
  expect(html).not.toContain("Opening the conversation.");
});
