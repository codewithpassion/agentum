import { describe, expect, test } from "bun:test";
import {
  agentIdForProfile,
  countOf,
  itemsText,
  labelOf,
  lastFiredText,
  outputWord,
  shownRunOf,
  triggerFacts,
  triggerWord,
  wiresFrom,
  wiresInto,
} from "./inspector-logic.ts";

const wire = (from: string, to: string, count7d: number) => ({
  active: false,
  count7d,
  from,
  kind: "trigger",
  to,
});

const graph = {
  nodes: [
    { key: "agent:a", label: "Bookkeeper" },
    { key: "trigger:t1", label: "Month end" },
  ],
  wires: [
    wire("trigger:t1", "agent:a", 4),
    wire("agent:a", "out:library:x", 2),
    wire("trigger:t2", "agent:a", 1),
  ],
};

const profile = {
  startsOn: {
    routines: [
      { id: "r1", lastFiredAt: "2026-10-20T08:00:00.000Z", name: "Daily" },
    ],
    triggers: [{ id: "t1", lastFiredAt: null, name: "Inbound mail" }],
  },
};

describe("wiresInto and wiresFrom", () => {
  test("returns the wires ending at a key", () => {
    expect(wiresInto(graph, "agent:a").map((w) => w.from)).toEqual([
      "trigger:t1",
      "trigger:t2",
    ]);
  });

  test("returns the wires starting at a key", () => {
    expect(wiresFrom(graph, "agent:a")).toEqual([
      wire("agent:a", "out:library:x", 2),
    ]);
  });

  test("returns nothing for a key no wire touches", () => {
    expect(wiresInto(graph, "agent:none")).toEqual([]);
    expect(wiresFrom(graph, "agent:none")).toEqual([]);
  });
});

describe("labelOf", () => {
  test("returns the label of a known node", () => {
    expect(labelOf(graph, "agent:a")).toBe("Bookkeeper");
  });

  test("returns the key when the graph has no such node", () => {
    expect(labelOf(graph, "out:library:x")).toBe("out:library:x");
  });
});

describe("triggerFacts", () => {
  test("reads a trigger from startsOn.triggers", () => {
    expect(triggerFacts("trigger:t1", profile)).toEqual({
      lastFiredAt: null,
      name: "Inbound mail",
    });
  });

  test("reads a routine from startsOn.routines", () => {
    expect(triggerFacts("trigger:r1", profile)).toEqual({
      lastFiredAt: "2026-10-20T08:00:00.000Z",
      name: "Daily",
    });
  });

  test("gives no facts for an id the profile does not list", () => {
    expect(triggerFacts("trigger:missing", profile)).toEqual({
      lastFiredAt: null,
      name: null,
    });
  });

  test("gives no facts for a slack key", () => {
    const slack = {
      startsOn: {
        routines: [],
        triggers: [
          {
            id: "slack:A1",
            lastFiredAt: "2026-10-20T08:00:00.000Z",
            name: "Slack",
          },
        ],
      },
    };
    expect(triggerFacts("trigger:slack:A1", slack)).toEqual({
      lastFiredAt: null,
      name: null,
    });
  });

  test("gives no facts for a key that is not a trigger key", () => {
    expect(triggerFacts("agent:t1", profile)).toEqual({
      lastFiredAt: null,
      name: null,
    });
  });

  test("gives no facts without a profile", () => {
    expect(triggerFacts("trigger:t1", null)).toEqual({
      lastFiredAt: null,
      name: null,
    });
  });
});

describe("countOf", () => {
  test("sums the 7-day counts", () => {
    expect(countOf([wire("a", "b", 4), wire("c", "d", 3)])).toBe(7);
  });

  test("is zero for no wires", () => {
    expect(countOf([])).toBe(0);
  });
});

describe("trigger and output words", () => {
  test("names each trigger kind", () => {
    expect(triggerWord("app")).toBe("App");
    expect(triggerWord("mail")).toBe("Mail");
    expect(triggerWord("routine")).toBe("Schedule");
    expect(triggerWord("http")).toBe("HTTP");
    expect(triggerWord("slack")).toBe("Slack");
  });

  test("falls back to the generic name for no kind", () => {
    expect(triggerWord(null)).toBe("Trigger");
  });

  test("names each output kind", () => {
    expect(outputWord("slack")).toBe("Slack");
    expect(outputWord("library")).toBe("Library");
    expect(outputWord("qa")).toBe("Q&A board");
    expect(outputWord("email")).toBe("Email");
  });

  test("falls back to the generic name for no kind", () => {
    expect(outputWord(null)).toBe("Output");
  });
});

describe("itemsText", () => {
  test("pluralises by count", () => {
    expect(itemsText(1)).toBe("1 item");
    expect(itemsText(0)).toBe("0 items");
    expect(itemsText(5)).toBe("5 items");
  });
});

describe("lastFiredText", () => {
  test("is unknown while the profile loads", () => {
    expect(
      lastFiredText({ lastFiredAt: null, name: "Inbound mail" }, false)
    ).toBe("unknown");
  });

  test("is unknown for a trigger the profile does not list", () => {
    expect(lastFiredText({ lastFiredAt: null, name: null }, true)).toBe(
      "unknown"
    );
  });

  test("is never for a listed trigger that has not fired", () => {
    expect(
      lastFiredText({ lastFiredAt: null, name: "Inbound mail" }, true)
    ).toBe("never");
  });

  test("is unknown for an unparsable time", () => {
    expect(
      lastFiredText({ lastFiredAt: "not a date", name: "Daily" }, true)
    ).toBe("unknown");
  });

  test("reads a fire time relative to now", () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(lastFiredText({ lastFiredAt: hourAgo, name: "Daily" }, true)).toBe(
      "about 1 hour ago"
    );
  });
});

describe("agentIdForProfile", () => {
  const agentGraph = {
    nodes: [],
    wires: [
      wire("trigger:t1", "agent:a", 1),
      wire("agent:a", "out:library:x", 1),
      wire("trigger:idle", "out:slack:C1", 0),
    ],
  };

  test("is the agent's own id for an agent node", () => {
    expect(
      agentIdForProfile(agentGraph, { key: "agent:a", kind: "agent" })
    ).toBe("a");
  });

  test("is the id of the agent a trigger starts", () => {
    expect(
      agentIdForProfile(agentGraph, { key: "trigger:t1", kind: "trigger" })
    ).toBe("a");
  });

  test("is null for a trigger that starts no agent", () => {
    expect(
      agentIdForProfile(agentGraph, { key: "trigger:idle", kind: "trigger" })
    ).toBeNull();
  });

  test("is null for an output", () => {
    expect(
      agentIdForProfile(agentGraph, { key: "out:library:x", kind: "output" })
    ).toBeNull();
  });
});

describe("shownRunOf", () => {
  const band = { text: "Done", tone: "ok" as const };
  const recent = [
    { id: "r3", statusBand: band, title: "Newest" },
    { id: "r2", statusBand: band, title: "Waiting one" },
  ];

  test("shows the newest run when nothing waits", () => {
    expect(shownRunOf(undefined, recent)?.id).toBe("r3");
    expect(shownRunOf(undefined, [])).toBeNull();
  });

  test("shows the waiting run even when a newer run exists", () => {
    expect(shownRunOf("r2", recent)).toEqual({
      band,
      id: "r2",
      title: "Waiting one",
    });
  });

  test("falls back to the waiting run id when it is not in the recent list", () => {
    expect(shownRunOf("r9", recent)).toEqual({
      band: null,
      id: "r9",
      title: "Waiting run",
    });
  });
});
