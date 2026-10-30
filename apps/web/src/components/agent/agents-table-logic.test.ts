import { describe, expect, test } from "bun:test";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  type AgentAskRef,
  askedName,
  doingNow,
  formatCost,
  rowsOf,
} from "./agents-table-logic.ts";

type Members = RouterOutputs["members"]["list"];
type OverviewRow = RouterOutputs["agents"]["overview"][number];

const members: Members = [
  { name: "Dan Ortiz", userId: "user_dan" },
  { name: "Priya Shah", userId: "user_priya" },
];

const agent = (overrides: Partial<AgentAskRef> = {}): AgentAskRef => ({
  createdBy: "user_priya",
  id: "agt_1",
  ownerUserId: null,
  ...overrides,
});

const overview = (overrides: Partial<OverviewRow> = {}): OverviewRow => ({
  agentId: "agt_1",
  costUsdThisWeek: 0,
  tasksThisWeek: 0,
  waiting: 0,
  working: 0,
  ...overrides,
});

describe("askedName", () => {
  test("names the owner when ownerUserId is set", () => {
    expect(askedName(agent({ ownerUserId: "user_dan" }), members)).toBe(
      "Dan Ortiz"
    );
  });

  test("falls back to the creator when ownerUserId is null", () => {
    expect(askedName(agent({ ownerUserId: null }), members)).toBe("Priya Shah");
  });

  test("says Nobody when the effective owner is not a member", () => {
    expect(askedName(agent({ ownerUserId: "user_gone" }), members)).toBe(
      "Nobody"
    );
    expect(
      askedName(agent({ createdBy: "user_gone", ownerUserId: null }), members)
    ).toBe("Nobody");
  });

  test("says Unknown when the member list failed to load", () => {
    expect(askedName(agent(), null)).toBe("Unknown");
  });

  test("says Nobody for an empty member list", () => {
    expect(askedName(agent(), [])).toBe("Nobody");
  });
});

describe("doingNow", () => {
  test("is Quiet without an overview row", () => {
    expect(doingNow(undefined)).toEqual([{ strong: false, text: "Quiet" }]);
  });

  test("is Quiet when nothing waits and nothing runs", () => {
    expect(doingNow(overview())).toEqual([{ strong: false, text: "Quiet" }]);
  });

  test("shows only waiting, in the strong style", () => {
    expect(doingNow(overview({ waiting: 3 }))).toEqual([
      { strong: true, text: "3 waiting" },
    ]);
  });

  test("shows only working, in the muted style", () => {
    expect(doingNow(overview({ working: 2 }))).toEqual([
      { strong: false, text: "2 working" },
    ]);
  });

  test("shows waiting strong then working muted when both are above zero", () => {
    expect(doingNow(overview({ waiting: 2, working: 1 }))).toEqual([
      { strong: true, text: "2 waiting" },
      { strong: false, text: "1 working" },
    ]);
  });
});

describe("rowsOf", () => {
  test("joins agents with their overview, asks and week count", () => {
    const rows = rowsOf(
      [
        agent({ id: "agt_1", ownerUserId: "user_dan" }),
        agent({ createdBy: "user_priya", id: "agt_2", ownerUserId: null }),
      ],
      [
        overview({
          agentId: "agt_2",
          costUsdThisWeek: 1.234,
          tasksThisWeek: 7,
          waiting: 1,
        }),
        overview({ agentId: "agt_1", tasksThisWeek: 2, working: 1 }),
      ],
      members
    );

    expect(rows.map((row) => row.agent.id)).toEqual(["agt_1", "agt_2"]);
    expect(rows[0]).toMatchObject({
      asked: "Dan Ortiz",
      doing: [{ strong: false, text: "1 working" }],
      tasksThisWeek: 2,
    });
    expect(rows[1]).toMatchObject({
      asked: "Priya Shah",
      cost: "$1.23",
      doing: [{ strong: true, text: "1 waiting" }],
      tasksThisWeek: 7,
    });
  });

  test("gives an agent with no overview row zero counts and no cost", () => {
    const [row] = rowsOf([agent({ id: "agt_9" })], [], members);
    expect(row).toMatchObject({
      cost: "Not reported",
      doing: [{ strong: false, text: "Quiet" }],
      tasksThisWeek: 0,
    });
  });

  test("keeps the agent object itself, so callers keep its fields", () => {
    const withName = { ...agent({ id: "agt_3" }), name: "Mail bot" };
    const [row] = rowsOf([withName], [], members);
    expect(row?.agent.name).toBe("Mail bot");
  });

  test("passes Unknown through when members failed", () => {
    const [row] = rowsOf([agent()], [], null);
    expect(row?.asked).toBe("Unknown");
  });

  test("returns no rows for no agents", () => {
    expect(rowsOf([], [overview()], members)).toEqual([]);
  });
});

describe("formatCost", () => {
  test.each([
    [null, "Not reported"],
    [0, "$0"],
    [0.004, "<$0.01"],
    [0.5, "$0.50"],
    [12.345, "$12.35"],
  ])("%p reads %p", (value, text) => {
    expect(formatCost(value)).toBe(text);
  });
});
