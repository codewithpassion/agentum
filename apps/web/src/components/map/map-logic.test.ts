import { expect, test } from "bun:test";
import type { AgentRuntime, MapGraph, MapNode, MapWire } from "@repo/db/shared";
import {
  agentIdOf,
  initialsOf,
  NODE_SIZE,
  runCountsByAgent,
  runtimeShort,
  toFlowEdges,
  toFlowNodes,
  toneOf,
  wireLabel,
} from "./map-logic.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T12:00:00Z");

function agentNode(id: string, overrides: Partial<MapNode> = {}): MapNode {
  return {
    key: `agent:${id}`,
    kind: "agent",
    label: "Triage Bot",
    ports: [{ id: "c1", kind: "connector", label: "Gmail" }],
    subkind: null,
    x: 10,
    y: 20,
    ...overrides,
  };
}

function wire(overrides: Partial<MapWire>): MapWire {
  return {
    active: false,
    count7d: 0,
    from: "trigger:t1",
    kind: "trigger",
    to: "agent:a1",
    ...overrides,
  };
}

function graphOf(nodes: MapNode[], wires: MapWire[] = []): MapGraph {
  return { nodes, wires };
}

const EMPTY_CTX = {
  agents: new Map<string, { runtime: AgentRuntime }>(),
  qaOpenCount: 0,
  runCounts: new Map<string, number>(),
  selectedKey: null,
};

test("a waiting agent shows waiting even when a wire into it is active", () => {
  const graph = graphOf(
    [agentNode("a1", { waiting: true })],
    [wire({ active: true })]
  );
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "agent" && node.data.status).toBe("waiting");
});

test("an agent is running when an incoming wire is active", () => {
  const graph = graphOf(
    [agentNode("a1")],
    [wire({ active: true, to: "agent:a1" })]
  );
  const [node] = toFlowNodes(graph, {
    ...EMPTY_CTX,
    runCounts: new Map([["a1", 0]]),
  });
  expect(node?.type === "agent" && node.data.status).toBe("running");
});

test("an active wire out of an agent does not make it running", () => {
  const graph = graphOf(
    [agentNode("a1")],
    [wire({ active: true, from: "agent:a1", kind: "qa", to: "out:qa" })]
  );
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "agent" && node.data.status).toBe("idle");
});

test("an agent with runs in the counts is ok, without runs it is idle", () => {
  const graph = graphOf([agentNode("a1"), agentNode("a2", { label: "Other" })]);
  const nodes = toFlowNodes(graph, {
    ...EMPTY_CTX,
    runCounts: new Map([["a1", 3]]),
  });
  const [ok, idle] = nodes;
  expect(ok?.type === "agent" && ok.data.status).toBe("ok");
  expect(idle?.type === "agent" && idle.data.status).toBe("idle");
});

test("status text names the runs and the runtime of a known agent", () => {
  const graph = graphOf([agentNode("a1"), agentNode("a2")]);
  const nodes = toFlowNodes(graph, {
    agents: new Map([["a1", { runtime: "managed" }]]),
    qaOpenCount: 0,
    runCounts: new Map([["a1", 31]]),
    selectedKey: null,
  });
  const [known, unknown] = nodes;
  expect(known?.type === "agent" && known.data.statusText).toBe(
    "31 runs · Anthropic cloud"
  );
  expect(unknown?.type === "agent" && unknown.data.statusText).toBe("0 runs");
});

test("status text uses the singular for one run and the pause text when waiting", () => {
  const graph = graphOf([agentNode("a1"), agentNode("a2", { waiting: true })]);
  const nodes = toFlowNodes(graph, {
    agents: new Map([["a1", { runtime: "machine" }]]),
    qaOpenCount: 0,
    runCounts: new Map([["a1", 1]]),
    selectedKey: null,
  });
  const [one, paused] = nodes;
  expect(one?.type === "agent" && one.data.statusText).toBe(
    "1 run · Our machine"
  );
  expect(paused?.type === "agent" && paused.data.statusText).toBe(
    "Paused, needs you"
  );
});

test("a running agent shows the same run text as an idle one", () => {
  const graph = graphOf(
    [agentNode("a1")],
    [wire({ active: true, to: "agent:a1" })]
  );
  const [node] = toFlowNodes(graph, {
    agents: new Map([["a1", { runtime: "cloud" }]]),
    qaOpenCount: 0,
    runCounts: new Map([["a1", 2]]),
    selectedKey: null,
  });
  expect(node?.type === "agent" && node.data.statusText).toBe(
    "2 runs · Cloudflare"
  );
});

test("runtimeShort names each runtime", () => {
  expect(runtimeShort("machine")).toBe("Our machine");
  expect(runtimeShort("managed")).toBe("Anthropic cloud");
  expect(runtimeShort("cloud")).toBe("Cloudflare");
  expect(runtimeShort("fake")).toBe("Test runner");
});

test("nodes keep their position and take the size for their kind", () => {
  const graph = graphOf([
    agentNode("a1", { x: 100, y: -40 }),
    {
      key: "trigger:t1",
      kind: "trigger",
      label: "Inbound",
      ports: [],
      subkind: "http",
      x: 5,
      y: 6,
    },
    {
      key: "out:qa",
      kind: "output",
      label: "Questions",
      ports: [],
      subkind: "qa",
      x: 7,
      y: 8,
    },
  ]);
  const [agent, trigger, output] = toFlowNodes(graph, EMPTY_CTX);
  expect(agent?.position).toEqual({ x: 100, y: -40 });
  expect(agent?.width).toBe(200);
  expect(agent?.height).toBe(76);
  expect(trigger?.position).toEqual({ x: 5, y: 6 });
  expect(trigger?.width).toBe(150);
  expect(trigger?.height).toBe(60);
  expect(output?.position).toEqual({ x: 7, y: 8 });
  expect(output?.width).toBe(170);
  expect(output?.height).toBe(60);
  expect(NODE_SIZE.agent).toEqual({ height: 76, width: 200 });
});

test("nodes carry their id, type and fixed flags, and only the selected one is selected", () => {
  const graph = graphOf([agentNode("a1"), agentNode("a2")]);
  const nodes = toFlowNodes(graph, {
    ...EMPTY_CTX,
    selectedKey: "agent:a2",
  });
  const [first, second] = nodes;
  expect(first?.id).toBe("agent:a1");
  expect(first?.type).toBe("agent");
  expect(first?.selected).toBe(false);
  expect(first?.draggable).toBe(false);
  expect(first?.connectable).toBe(false);
  expect(second?.selected).toBe(true);
});

test("agent ports map to kind and label", () => {
  const graph = graphOf([agentNode("a1")]);
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "agent" && node.data.ports).toEqual([
    { id: "c1", kind: "connector", label: "Gmail" },
  ]);
  expect(node?.type === "agent" && node.data.initials).toBe("TB");
});

test("a trigger is active only while a wire out of it is active", () => {
  const graph = graphOf(
    [
      {
        key: "trigger:t1",
        kind: "trigger",
        label: "Inbound",
        ports: [],
        subkind: "mail",
        x: 0,
        y: 0,
      },
      {
        key: "trigger:t2",
        kind: "trigger",
        label: "Cron",
        ports: [],
        subkind: null,
        x: 0,
        y: 0,
      },
    ],
    [wire({ active: true, from: "trigger:t1", to: "agent:a1" })]
  );
  const [mail, cron] = toFlowNodes(graph, EMPTY_CTX);
  expect(mail?.type === "trigger" && mail.data.active).toBe(true);
  expect(mail?.type === "trigger" && mail.data.subkind).toBe("mail");
  expect(cron?.type === "trigger" && cron.data.active).toBe(false);
  expect(cron?.type === "trigger" && cron.data.subkind).toBe("http");
  expect(cron?.type === "trigger" && cron.data.detail).toBe("");
});

test("an output sums its incoming counts in the kind of its subkind", () => {
  const graph = graphOf(
    [
      {
        key: "out:library:notes",
        kind: "output",
        label: "Notes",
        ports: [],
        subkind: "library",
        x: 0,
        y: 0,
      },
    ],
    [
      wire({
        count7d: 1,
        from: "agent:a1",
        kind: "library",
        to: "out:library:notes",
      }),
      wire({
        count7d: 4,
        from: "agent:a2",
        kind: "library",
        to: "out:library:notes",
      }),
      wire({ count7d: 9, from: "agent:a3", kind: "library", to: "out:other" }),
    ]
  );
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "output" && node.data.detail).toBe("5 writes");
  expect(node?.type === "output" && node.data.subkind).toBe("library");
});

test("an output with no incoming wires reads zero", () => {
  const graph = graphOf([
    {
      key: "out:email:bob",
      kind: "output",
      label: "Bob",
      ports: [],
      subkind: "email",
      x: 0,
      y: 0,
    },
  ]);
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "output" && node.data.detail).toBe("0 emails");
  expect(node?.type === "output" && node.data.subkind).toBe("email");
});

test("a qa output reads its open question count, not the wire count", () => {
  const graph = graphOf(
    [
      {
        key: "out:qa:board",
        kind: "output",
        label: "Q&A",
        ports: [],
        subkind: "qa",
        x: 0,
        y: 0,
      },
    ],
    [
      wire({
        count7d: 9,
        from: "agent:a1",
        kind: "qa",
        to: "out:qa:board",
      }),
    ]
  );
  const [node] = toFlowNodes(graph, { ...EMPTY_CTX, qaOpenCount: 3 });
  expect(node?.type === "output" && node.data.detail).toBe("3 open");
  expect(node?.type === "output" && node.data.subkind).toBe("qa");
});

test("a qa output with no open questions reads zero open", () => {
  const graph = graphOf([
    {
      key: "out:qa:board",
      kind: "output",
      label: "Q&A",
      ports: [],
      subkind: "qa",
      x: 0,
      y: 0,
    },
  ]);
  const [node] = toFlowNodes(graph, EMPTY_CTX);
  expect(node?.type === "output" && node.data.detail).toBe("0 open");
});

test("toFlowEdges gives each wire an id, a label and its data", () => {
  const graph: MapGraph = {
    nodes: [],
    wires: [
      wire({
        active: true,
        count7d: 0,
        from: "trigger:t1",
        kind: "trigger",
        to: "agent:a1",
      }),
      wire({
        active: false,
        count7d: 3,
        from: "agent:a1",
        kind: "qa",
        to: "out:qa",
      }),
      wire({
        active: false,
        count7d: 0,
        from: "agent:a1",
        kind: "email",
        to: "out:email:x",
      }),
    ],
  };
  const [live, carried, idle] = toFlowEdges(graph);
  expect(live?.id).toBe("trigger:trigger:t1:agent:a1");
  expect(live?.source).toBe("trigger:t1");
  expect(live?.target).toBe("agent:a1");
  expect(live?.type).toBe("count");
  expect(live?.label).toBe("0 runs");
  expect(live?.animated).toBe(true);
  expect(live?.data).toEqual({
    active: true,
    carried: true,
    deletable: false,
    kind: "trigger",
  });

  expect(carried?.id).toBe("qa:agent:a1:out:qa");
  expect(carried?.label).toBe("3 questions");
  expect(carried?.animated).toBe(false);
  expect(carried?.data).toEqual({
    active: false,
    carried: true,
    deletable: false,
    kind: "qa",
  });

  expect(idle?.label).toBe("0 emails");
  expect(idle?.data).toEqual({
    active: false,
    carried: false,
    deletable: false,
    kind: "email",
  });
});

test("toFlowEdges runs handoffs vertically and other wires left to right", () => {
  const node = (key: string, y: number) => ({
    key,
    kind: "agent" as const,
    label: key,
    ports: [],
    subkind: null,
    x: 0,
    y,
  });
  const handoff = (from: string, to: string) => ({
    active: false,
    count7d: 1,
    from,
    kind: "handoff" as const,
    to,
  });
  const graph = {
    nodes: [node("agent:top", 0), node("agent:low", 160)],
    wires: [
      handoff("agent:top", "agent:low"),
      handoff("agent:low", "agent:top"),
      { ...handoff("agent:top", "out:qa"), kind: "qa" as const },
    ],
  };
  const [down, up, side] = toFlowEdges(graph);
  const [level] = toFlowEdges({
    nodes: [node("agent:a", 0), node("agent:b", 0)],
    wires: [handoff("agent:a", "agent:b")],
  });
  expect([level?.sourceHandle, level?.targetHandle]).toEqual(["right", "left"]);
  expect([down?.sourceHandle, down?.targetHandle]).toEqual(["bottom", "top"]);
  expect([up?.sourceHandle, up?.targetHandle]).toEqual([
    "top-out",
    "bottom-in",
  ]);
  expect([side?.sourceHandle, side?.targetHandle]).toEqual(["right", "left"]);
});

test("wireLabel uses the singular for one and the plural otherwise", () => {
  expect(wireLabel({ count7d: 1, kind: "trigger" })).toBe("1 run");
  expect(wireLabel({ count7d: 2, kind: "trigger" })).toBe("2 runs");
  expect(wireLabel({ count7d: 0, kind: "trigger" })).toBe("0 runs");
  expect(wireLabel({ count7d: 1, kind: "handoff" })).toBe("1 handoff");
  expect(wireLabel({ count7d: 5, kind: "handoff" })).toBe("5 handoffs");
  expect(wireLabel({ count7d: 1, kind: "slack" })).toBe("1 message");
  expect(wireLabel({ count7d: 2, kind: "slack" })).toBe("2 messages");
  expect(wireLabel({ count7d: 1, kind: "library" })).toBe("1 write");
  expect(wireLabel({ count7d: 2, kind: "library" })).toBe("2 writes");
  expect(wireLabel({ count7d: 1, kind: "qa" })).toBe("1 question");
  expect(wireLabel({ count7d: 2, kind: "qa" })).toBe("2 questions");
  expect(wireLabel({ count7d: 1, kind: "email" })).toBe("1 email");
  expect(wireLabel({ count7d: 2, kind: "email" })).toBe("2 emails");
});

test("runCountsByAgent counts runs inside the window and skips bad dates", () => {
  const tasks = [
    { agentId: "a1", createdAt: new Date(NOW - 1 * DAY_MS).toISOString() },
    { agentId: "a1", createdAt: new Date(NOW - 2 * DAY_MS).toISOString() },
    { agentId: "a2", createdAt: new Date(NOW).toISOString() },
    { agentId: "a2", createdAt: "not a date" },
  ];
  const counts = runCountsByAgent(tasks, NOW);
  expect(counts.get("a1")).toBe(2);
  expect(counts.get("a2")).toBe(1);
  expect(counts.size).toBe(2);
});

test("runCountsByAgent includes a run exactly 7 days old and drops one 8 days old", () => {
  const tasks = [
    { agentId: "a1", createdAt: new Date(NOW - 7 * DAY_MS).toISOString() },
    { agentId: "a2", createdAt: new Date(NOW - 8 * DAY_MS).toISOString() },
  ];
  const counts = runCountsByAgent(tasks, NOW);
  expect(counts.get("a1")).toBe(1);
  expect(counts.has("a2")).toBe(false);
});

test("runCountsByAgent honours a custom window length", () => {
  const tasks = [
    { agentId: "a1", createdAt: new Date(NOW - 2 * DAY_MS).toISOString() },
  ];
  expect(runCountsByAgent(tasks, NOW, 1).has("a1")).toBe(false);
  expect(runCountsByAgent(tasks, NOW, 2).get("a1")).toBe(1);
});

test("initialsOf takes two words' first letters, or a single word's first two", () => {
  expect(initialsOf("Triage Bot")).toBe("TB");
  expect(initialsOf("gmail sorter helper")).toBe("GS");
  expect(initialsOf("research")).toBe("RE");
  expect(initialsOf("  spaced   out  ")).toBe("SO");
  expect(initialsOf("x")).toBe("X");
  expect(initialsOf("")).toBe("?");
  expect(initialsOf("   ")).toBe("?");
});

test("agentIdOf returns the id for agent keys and null otherwise", () => {
  expect(agentIdOf("agent:abc123")).toBe("abc123");
  expect(agentIdOf("agent:")).toBe("");
  expect(agentIdOf("trigger:agent:x")).toBe(null);
  expect(agentIdOf("out:qa")).toBe(null);
});

test("toneOf is stable and stays within 1 to 4", () => {
  const keys = ["agent:a1", "agent:a2", "trigger:t1", "out:qa", "out:email:x"];
  for (const key of keys) {
    const tone = toneOf(key);
    expect(tone).toBeGreaterThanOrEqual(1);
    expect(tone).toBeLessThanOrEqual(4);
    expect(toneOf(key)).toBe(tone);
  }
});

test("editor mode makes every node draggable and none deletable", () => {
  const graph = graphOf([agentNode("a1")]);
  const [readOnly] = toFlowNodes(graph, EMPTY_CTX);
  const [editing] = toFlowNodes(graph, { ...EMPTY_CTX, editor: true });
  expect(readOnly?.draggable).toBe(false);
  expect(editing?.draggable).toBe(true);
  expect(editing?.connectable).toBe(true);
  expect(editing?.deletable).toBe(false);
});

test("editor mode marks only the wires of http and routine triggers deletable", () => {
  const trigger = (id: string, subkind: "http" | "mail"): MapNode => ({
    key: `trigger:${id}`,
    kind: "trigger",
    label: id,
    ports: [],
    subkind,
    x: 0,
    y: 0,
  });
  const graph = graphOf(
    [agentNode("a1"), trigger("h", "http"), trigger("m", "mail")],
    [
      wire({ from: "trigger:h" }),
      wire({ from: "trigger:m" }),
      wire({ from: "agent:a1", kind: "handoff", to: "agent:a1" }),
    ]
  );
  expect(toFlowEdges(graph).map((edge) => edge.deletable)).toEqual([
    false,
    false,
    false,
  ]);
  expect(toFlowEdges(graph, true).map((edge) => edge.deletable)).toEqual([
    true,
    false,
    false,
  ]);
});
