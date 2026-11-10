import { expect, test } from "bun:test";
import {
  type AskBeforeAction,
  askSummary,
  groupActions,
  isPresetLevel,
} from "./ask-groups.ts";

const action = (
  key: string,
  group: string,
  ask: boolean,
  covers?: string
): AskBeforeAction => ({
  action: key,
  ask,
  group,
  kind: group === "Built-in tools" ? "builtin" : "connector",
  label: key,
  overridden: false,
  ...(covers === undefined ? {} : { covers }),
});

test("groups follow first appearance and count the switches that ask", () => {
  const groups = groupActions([
    action("bash", "Built-in tools", true, "Also the shell."),
    action("write", "Built-in tools", false, "Also the shell."),
    action("xero/a", "Xero", true),
    action("xero/b", "Xero", true),
  ]);
  expect(groups.map((group) => group.name)).toEqual(["Built-in tools", "Xero"]);
  expect(groups.map(askSummary)).toEqual(["1 of 2 ask", "2 of 2 ask"]);
  expect(groups[0]?.covers).toEqual(["Also the shell."]);
  expect(groups[1]?.covers).toEqual([]);
});

test("custom is not a level a person picks", () => {
  expect(isPresetLevel("outside")).toBe(true);
  expect(isPresetLevel("custom")).toBe(false);
});
