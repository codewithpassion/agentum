import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { JobsTab } from "./index.tsx";

test("Jobs shows the triggers and routines", () => {
  const html = renderInRoom(<JobsTab {...fixtureTabProps()} />);
  expect(html).toContain("Triggers");
  expect(html).toContain("Routines");
});
