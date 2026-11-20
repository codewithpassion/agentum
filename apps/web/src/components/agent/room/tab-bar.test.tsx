import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TabBar } from "./tab-bar.tsx";
import { ROOM_TABS } from "./tabs.ts";

const noop = (): void => undefined;

test("the bar shows the seven tabs in order and marks the open one", () => {
  const html = renderToStaticMarkup(<TabBar onSelect={noop} selected="keys" />);
  expect(html).toContain('role="tablist"');
  expect(html.match(/role="tab"/g)).toHaveLength(ROOM_TABS.length);
  const order = ["Chat", "Work", "Files", "Knows", "Keys", "Jobs", "Settings"];
  const positions = order.map((label) => html.indexOf(`>${label}<`));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  expect(html).toContain('aria-controls="room-panel-keys"');
});
