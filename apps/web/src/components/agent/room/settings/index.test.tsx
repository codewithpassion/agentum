import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { SettingsTab } from "./index.tsx";

test("Settings shows where the agent runs, the move action and the agent form", () => {
  const html = renderInRoom(<SettingsTab {...fixtureTabProps()} />);
  expect(html).toContain("Runs on");
  expect(html).toContain("Move agent");
  expect(html).toContain("Edit agent");
  expect(html).toContain("Cloud");
});

test("Settings names the machine the agent runs on", () => {
  const props = fixtureTabProps();
  const base = props.room;
  const html = renderInRoom(
    <SettingsTab
      {...props}
      room={{
        ...base,
        agent: { ...base.agent, runtime: "machine" },
        profile: {
          ...base.profile,
          header: {
            ...base.profile.header,
            machine: { id: "m1", name: "laptop", status: "online" },
            runtime: "machine",
          },
        },
      }}
    />
  );
  expect(html).toContain("laptop");
});
