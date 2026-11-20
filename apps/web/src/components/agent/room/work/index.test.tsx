import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { WorkTab } from "./index.tsx";

test("Work shows the recent tasks card", () => {
  const html = renderInRoom(<WorkTab {...fixtureTabProps()} />);
  expect(html).toContain("Recent tasks");
  expect(html).toContain("No tasks yet.");
});
