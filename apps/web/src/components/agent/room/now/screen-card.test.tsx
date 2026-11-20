import { expect, test } from "bun:test";
import { renderInRoom } from "../test-fixtures.tsx";
import { ScreenCard } from "./screen-card.tsx";

const WATCH_BUTTON = /<button[^>]*aria-pressed="false"[^>]*>Watch<\/button>/;
const DISABLED_TAKE_OVER = /<button[^>]* disabled=""[^>]*>Take over<\/button>/;
const ENABLED_TAKE_OVER =
  /<button(?![^>]* disabled="")[^>]*>Take over<\/button>/;

test("an agent without a computer shows no screen card", () => {
  const html = renderInRoom(
    <ScreenCard agentName="Sorter" machineId={null} takeover={null} />
  );
  expect(html).toBe("");
});

test("a computer with no takeover request offers Watch and a disabled Take over", () => {
  const html = renderInRoom(
    <ScreenCard agentName="Sorter" machineId="machine_1" takeover={null} />
  );
  expect(html).toContain('aria-label="Screen"');
  expect(html).toMatch(WATCH_BUTTON);
  expect(html).toMatch(DISABLED_TAKE_OVER);
  expect(html).toContain("Sorter has not asked for you.");
});

test("an open takeover request enables Take over and says the agent waits", () => {
  const html = renderInRoom(
    <ScreenCard
      agentName="Sorter"
      machineId="machine_1"
      takeover={{ reason: "Log in", requestId: "req_1" }}
    />
  );
  expect(html).toMatch(ENABLED_TAKE_OVER);
  expect(html).toContain("Sorter is waiting for you.");
});

test("the live view stays closed until someone clicks Watch", () => {
  const html = renderInRoom(
    <ScreenCard agentName="Sorter" machineId="machine_1" takeover={null} />
  );
  expect(html).not.toContain('data-testid="desktop-screen"');
});
