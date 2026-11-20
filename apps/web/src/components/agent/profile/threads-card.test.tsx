import { expect, test } from "bun:test";
import { renderInRoom } from "../room/test-fixtures.tsx";
import { ThreadsCard } from "./threads-card.tsx";

test("the buttons in the card header wrap instead of running past the card", () => {
  const html = renderInRoom(
    <ThreadsCard
      agent={{ id: "agent_1", name: "Sorter" }}
      archived={false}
      threads={[]}
    />
  );
  expect(html).toContain("Open main conversation");
  expect(html).toContain("New conversation");
  expect(html).toContain('class="flex flex-wrap gap-2"');
});
