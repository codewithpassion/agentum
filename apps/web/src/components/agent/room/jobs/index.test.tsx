import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { JobsTab } from "./index.tsx";

test("Jobs shows the box to describe a job and loads the agent's jobs", () => {
  const html = renderInRoom(<JobsTab {...fixtureTabProps()} />);
  expect(html).toContain("Describe a new job");
  expect(html).toContain("Loading jobs.");
});

test("Jobs of an archived agent are read only", () => {
  const props = fixtureTabProps();
  const html = renderInRoom(
    <JobsTab
      {...props}
      room={{
        ...props.room,
        agent: { ...props.room.agent, status: "archived" },
      }}
    />
  );
  expect(html).toContain("This agent is archived");
  expect(html).not.toContain("Describe a new job");
});
