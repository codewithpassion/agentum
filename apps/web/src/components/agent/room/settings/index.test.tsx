import { expect, test } from "bun:test";
import { fixtureTabProps, renderInRoom } from "../test-fixtures.tsx";
import { SettingsTab } from "./index.tsx";

const AGENT_CAP_INPUT = /id="agent-cap"[^>]*value="20"/;

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

test("Settings has a weekly spend limit that shows the saved cap", () => {
  const props = fixtureTabProps();
  const base = props.room;
  const html = renderInRoom(
    <SettingsTab
      {...props}
      room={{ ...base, spend: { ...base.spend, capCents: 2000 } }}
    />
  );
  expect(html).toContain("Weekly spend limit");
  expect(html).toContain("Weekly limit");
  expect(html).toMatch(AGENT_CAP_INPUT);
});
