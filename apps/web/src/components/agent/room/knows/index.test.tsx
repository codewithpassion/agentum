import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { KnowsTab } from "./index.tsx";

test("Knows shows the instructions, voice and skills", () => {
  const html = renderInRoom(<KnowsTab {...fixtureTabProps()} />);
  expect(html).toContain("Instructions");
  expect(html).toContain("Voice");
  expect(html).toContain("Skills");
  expect(html).toContain("Sort the inbox every morning.");
});
