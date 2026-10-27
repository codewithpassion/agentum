import { expect, test } from "bun:test";
import type { MachineRecord } from "#/integrations/trpc/types";
import {
  buildPalette,
  connectChoices,
  decodeNewNode,
  decodeTool,
  deletableWiresFrom,
  disconnectMessage,
  type EditGraph,
  encodeNewNode,
  encodeTool,
  isDeletableWire,
  isMovableTrigger,
  isValidTriggerConnection,
  moveWireMessage,
  NEW_NODE_MIME,
  newNodeKeys,
  positionsToSave,
  TOOL_MIME,
  toolKey,
  toolOfPort,
  triggerIdOfKey,
} from "./editor-logic.ts";

const graph: EditGraph = {
  nodes: [
    {
      key: "trigger:h1",
      kind: "trigger",
      label: "Daily report",
      subkind: "http",
    },
    {
      key: "trigger:r1",
      kind: "trigger",
      label: "Weekly sync",
      subkind: "routine",
    },
    { key: "trigger:m1", kind: "trigger", label: "Inbox", subkind: "mail" },
    {
      key: "trigger:slack:T1",
      kind: "trigger",
      label: "Slack",
      subkind: "slack",
    },
    {
      key: "agent:researcher",
      kind: "agent",
      label: "Researcher",
      subkind: null,
    },
    {
      key: "agent:bookkeeper",
      kind: "agent",
      label: "Bookkeeper",
      subkind: null,
    },
    { key: "out:qa", kind: "output", label: "Q&A board", subkind: "qa" },
  ],
  wires: [
    {
      configured: true,
      from: "trigger:h1",
      kind: "trigger",
      to: "agent:researcher",
    },
    { configured: false, from: "agent:researcher", kind: "qa", to: "out:qa" },
    {
      configured: true,
      from: "trigger:slack:T1",
      kind: "trigger",
      to: "agent:bookkeeper",
    },
  ],
};

const machine = (
  overrides: Partial<
    Pick<MachineRecord, "computerStatus" | "id" | "name" | "roles" | "status">
  >
): Pick<
  MachineRecord,
  "computerStatus" | "id" | "name" | "roles" | "status"
> => ({
  computerStatus: "online",
  id: "m1",
  name: "Desk Mac",
  roles: ["computer"],
  status: "online",
  ...overrides,
});

test("encodeTool and decodeTool round-trip every tool kind", () => {
  const tools = [
    { id: "abc", kind: "connector" },
    { id: "sk_1", kind: "skill" },
    { id: "m1", kind: "computer" },
    { kind: "browser" },
  ] as const;
  for (const tool of tools) {
    expect(decodeTool(encodeTool(tool))).toEqual(tool);
  }
});

test("MIME names are fixed strings", () => {
  expect(TOOL_MIME).toBe("application/x-harbourmaster-tool");
  expect(NEW_NODE_MIME).toBe("application/x-harbourmaster-new-node");
});

test("decodeTool rejects bad JSON", () => {
  expect(decodeTool("{not json")).toBeNull();
  expect(decodeTool("")).toBeNull();
});

test("decodeTool rejects an unknown kind", () => {
  expect(decodeTool(JSON.stringify({ id: "x", kind: "widget" }))).toBeNull();
  expect(decodeTool("null")).toBeNull();
  expect(decodeTool("[]")).toBeNull();
});

test("decodeTool rejects a missing or empty id on id-bearing kinds", () => {
  expect(decodeTool(JSON.stringify({ kind: "connector" }))).toBeNull();
  expect(decodeTool(JSON.stringify({ id: "", kind: "skill" }))).toBeNull();
  expect(decodeTool(JSON.stringify({ id: 7, kind: "computer" }))).toBeNull();
});

test("decodeTool accepts browser without an id", () => {
  expect(decodeTool(JSON.stringify({ kind: "browser" }))).toEqual({
    kind: "browser",
  });
});

test("encodeNewNode and decodeNewNode round-trip trigger and agent", () => {
  expect(decodeNewNode(encodeNewNode("trigger"))).toBe("trigger");
  expect(decodeNewNode(encodeNewNode("agent"))).toBe("agent");
});

test("decodeNewNode rejects bad input and other kinds", () => {
  expect(decodeNewNode("agent")).toBeNull();
  expect(decodeNewNode(JSON.stringify({ kind: "output" }))).toBeNull();
  expect(decodeNewNode(JSON.stringify({ kind: 1 }))).toBeNull();
});

test("toolOfPort maps a port to a tool, and browser has no id", () => {
  expect(toolOfPort({ id: "c1", kind: "connector" })).toEqual({
    id: "c1",
    kind: "connector",
  });
  expect(toolOfPort({ id: "s1", kind: "skill" })).toEqual({
    id: "s1",
    kind: "skill",
  });
  expect(toolOfPort({ id: "", kind: "browser" })).toEqual({ kind: "browser" });
});

test("toolKey names each tool", () => {
  expect(toolKey({ id: "abc", kind: "connector" })).toBe("connector:abc");
  expect(toolKey({ id: "sk_1", kind: "skill" })).toBe("skill:sk_1");
  expect(toolKey({ id: "m1", kind: "computer" })).toBe("computer:m1");
  expect(toolKey({ kind: "browser" })).toBe("browser");
});

test("isMovableTrigger is true only for http and routine", () => {
  expect(isMovableTrigger("http")).toBe(true);
  expect(isMovableTrigger("routine")).toBe(true);
  expect(isMovableTrigger("mail")).toBe(false);
  expect(isMovableTrigger("slack")).toBe(false);
  expect(isMovableTrigger(null)).toBe(false);
});

test("triggerIdOfKey returns the id of a trigger key", () => {
  expect(triggerIdOfKey("trigger:h1")).toBe("h1");
  expect(triggerIdOfKey("trigger:slack:T1")).toBeNull();
  expect(triggerIdOfKey("agent:researcher")).toBeNull();
  expect(triggerIdOfKey("trigger:")).toBeNull();
});

test("isValidTriggerConnection accepts a movable trigger to an agent", () => {
  expect(
    isValidTriggerConnection(graph, "trigger:h1", "agent:bookkeeper")
  ).toBe(true);
  expect(
    isValidTriggerConnection(graph, "trigger:r1", "agent:bookkeeper")
  ).toBe(true);
});

test("isValidTriggerConnection rejects a mail or slack trigger", () => {
  expect(
    isValidTriggerConnection(graph, "trigger:m1", "agent:researcher")
  ).toBe(false);
  expect(
    isValidTriggerConnection(graph, "trigger:slack:T1", "agent:researcher")
  ).toBe(false);
});

test("isValidTriggerConnection rejects a wire that already exists", () => {
  expect(
    isValidTriggerConnection(graph, "trigger:h1", "agent:researcher")
  ).toBe(false);
});

test("isValidTriggerConnection rejects a missing node or a non-agent target", () => {
  expect(
    isValidTriggerConnection(graph, "trigger:nope", "agent:researcher")
  ).toBe(false);
  expect(isValidTriggerConnection(graph, "trigger:h1", "trigger:r1")).toBe(
    false
  );
  expect(isValidTriggerConnection(graph, "trigger:h1", "agent:missing")).toBe(
    false
  );
  expect(isValidTriggerConnection(graph, "agent:researcher", "out:qa")).toBe(
    false
  );
});

test("moveWireMessage names the trigger, the old agent and the new agent", () => {
  expect(moveWireMessage(graph, "trigger:h1", "agent:bookkeeper")).toEqual({
    body: '"Daily report" starts Researcher today. Start Bookkeeper instead? Researcher will no longer be started by it.',
    title: "Move this wire?",
  });
});

test("moveWireMessage asks to connect when the trigger has no wire", () => {
  const unwired: EditGraph = { ...graph, wires: [] };
  expect(moveWireMessage(unwired, "trigger:r1", "agent:bookkeeper")).toEqual({
    body: 'Connect "Weekly sync" to Bookkeeper?',
    title: "Connect this trigger?",
  });
});

test("isDeletableWire is true for a trigger wire from a movable trigger", () => {
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "trigger:h1",
      kind: "trigger",
    })
  ).toBe(true);
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "trigger:r1",
      kind: "trigger",
    })
  ).toBe(true);
});

test("isDeletableWire is false for mail, slack, other wire kinds and missing sources", () => {
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "trigger:m1",
      kind: "trigger",
    })
  ).toBe(false);
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "trigger:slack:T1",
      kind: "trigger",
    })
  ).toBe(false);
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "agent:researcher",
      kind: "qa",
    })
  ).toBe(false);
  expect(
    isDeletableWire(graph, {
      configured: true,
      from: "trigger:nope",
      kind: "trigger",
    })
  ).toBe(false);
});

test("a trigger moved to another agent leaves a historical wire to the old one", () => {
  // "h1" fired for the researcher, then moved to the bookkeeper.
  const moved: EditGraph = {
    ...graph,
    wires: [
      {
        configured: false,
        from: "trigger:h1",
        kind: "trigger",
        to: "agent:researcher",
      },
      {
        configured: true,
        from: "trigger:h1",
        kind: "trigger",
        to: "agent:bookkeeper",
      },
    ],
  };
  expect(
    isValidTriggerConnection(moved, "trigger:h1", "agent:researcher")
  ).toBe(true);
  expect(
    isValidTriggerConnection(moved, "trigger:h1", "agent:bookkeeper")
  ).toBe(false);
  expect(
    isDeletableWire(moved, {
      configured: false,
      from: "trigger:h1",
      kind: "trigger",
    })
  ).toBe(false);
  expect(
    isDeletableWire(moved, {
      configured: true,
      from: "trigger:h1",
      kind: "trigger",
    })
  ).toBe(true);
  expect(moveWireMessage(moved, "trigger:h1", "agent:researcher")).toEqual({
    body: '"Daily report" starts Bookkeeper today. Start Researcher instead? Bookkeeper will no longer be started by it.',
    title: "Move this wire?",
  });
});

test("disconnectMessage for an http trigger revokes it for good", () => {
  expect(disconnectMessage(graph, "trigger:h1")).toEqual({
    body: 'Deleting this wire revokes "Daily report" for good. Its address and secret stop working.',
    confirm: "Revoke trigger",
    title: "Revoke this trigger?",
  });
});

test("disconnectMessage for a routine removes the schedule", () => {
  expect(disconnectMessage(graph, "trigger:r1")).toEqual({
    body: 'Deleting this wire removes the routine "Weekly sync".',
    confirm: "Remove schedule",
    title: "Remove this schedule?",
  });
});

test("disconnectMessage for any other node uses the generic title", () => {
  const generic = disconnectMessage(graph, "trigger:m1");
  expect(generic.title).toBe("Delete this wire?");
  expect(disconnectMessage(graph, "agent:researcher").title).toBe(
    "Delete this wire?"
  );
  expect(disconnectMessage(graph, "trigger:nope").title).toBe(
    "Delete this wire?"
  );
});

test("positionsToSave rounds coordinates to integers", () => {
  const pending = new Map([["agent:a", { x: 10.4, y: -3.6 }]]);
  expect(positionsToSave(pending)).toEqual([{ key: "agent:a", x: 10, y: -4 }]);
});

test("positionsToSave keeps only keys the server accepts", () => {
  const pending = new Map([
    ["agent:a", { x: 1, y: 1 }],
    ["trigger:h1", { x: 2, y: 2 }],
    ["trigger:slack:T1", { x: 3, y: 3 }],
    ["out:slack:C1", { x: 4, y: 4 }],
    ["out:library:Notes/a b.md", { x: 5, y: 5 }],
    ["out:qa", { x: 6, y: 6 }],
    ["out:email:team", { x: 7, y: 7 }],
    ["agent:a:b", { x: 8, y: 8 }],
    ["agent:", { x: 9, y: 9 }],
    ["trigger:slack:", { x: 10, y: 10 }],
    ["out:library:bad\u0007name", { x: 11, y: 11 }],
    ["out:library:", { x: 12, y: 12 }],
    ["out:email:a b", { x: 13, y: 13 }],
    ["out:qa:extra", { x: 14, y: 14 }],
    ["something:else", { x: 15, y: 15 }],
  ]);
  expect(positionsToSave(pending).map((entry) => entry.key)).toEqual([
    "agent:a",
    "trigger:h1",
    "trigger:slack:T1",
    "out:slack:C1",
    "out:library:Notes/a b.md",
    "out:qa",
    "out:email:team",
  ]);
});

test("positionsToSave caps the result at 500 entries", () => {
  const pending = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < 600; i += 1) {
    pending.set(`agent:a${i}`, { x: i, y: i });
  }
  const saved = positionsToSave(pending);
  expect(saved).toHaveLength(500);
  expect(saved[0]).toEqual({ key: "agent:a0", x: 0, y: 0 });
  expect(saved[499]).toEqual({ key: "agent:a499", x: 499, y: 499 });
});

test("positionsToSave drops non-finite coordinates", () => {
  const pending = new Map([
    ["agent:a", { x: Number.NaN, y: 1 }],
    ["agent:b", { x: 1, y: Number.POSITIVE_INFINITY }],
    ["agent:c", { x: 2, y: 3 }],
  ]);
  expect(positionsToSave(pending)).toEqual([{ key: "agent:c", x: 2, y: 3 }]);
});

test("newNodeKeys returns keys added after, in order", () => {
  expect(
    newNodeKeys(
      ["agent:a", "agent:b"],
      ["agent:b", "trigger:h1", "agent:a", "out:qa"]
    )
  ).toEqual(["trigger:h1", "out:qa"]);
});

test("newNodeKeys is empty when nothing was added", () => {
  expect(newNodeKeys(["agent:a"], ["agent:a"])).toEqual([]);
  expect(newNodeKeys([], [])).toEqual([]);
  expect(newNodeKeys(["agent:a"], [])).toEqual([]);
});

test("buildPalette makes four sections in order", () => {
  const sections = buildPalette({ connectors: [], machines: [], skills: [] });
  expect(sections.map((section) => section.title)).toEqual([
    "Connectors",
    "Skills",
    "Computers",
    "Browser",
  ]);
});

test("buildPalette lists connectors with ready and needs-setup states", () => {
  const [connectors] = buildPalette({
    connectors: [
      { id: "c1", name: "Gmail", status: "ok" },
      { id: "c2", name: "Notion", status: "needs_auth" },
    ],
    machines: [],
    skills: [],
  });
  expect(connectors?.items).toEqual([
    {
      detail: "Ready",
      key: "connector:c1",
      label: "Gmail",
      setup: null,
      tool: { id: "c1", kind: "connector" },
    },
    {
      detail: "Needs setup",
      key: "connector:c2",
      label: "Notion",
      setup: { href: "/settings/connectors", label: "Set up" },
      tool: { id: "c2", kind: "connector" },
    },
  ]);
  expect(connectors?.empty).toBeNull();
});

test("buildPalette gives the connector empty state when there are none", () => {
  const [connectors] = buildPalette({
    connectors: [],
    machines: [],
    skills: [],
  });
  expect(connectors?.items).toEqual([]);
  expect(connectors?.empty).toEqual({
    href: "/settings/connectors",
    label: "Add a connector",
    text: "No connectors yet.",
  });
});

test("buildPalette lists only skills with no owning agent", () => {
  const [, skills] = buildPalette({
    connectors: [],
    machines: [],
    skills: [
      { id: "s1", name: "Summarise", ownerAgentId: null },
      { id: "s2", name: "Private", ownerAgentId: "agent_1" },
    ],
  });
  expect(skills?.items).toEqual([
    {
      detail: "",
      key: "skill:s1",
      label: "Summarise",
      setup: null,
      tool: { id: "s1", kind: "skill" },
    },
  ]);
  expect(skills?.empty).toBeNull();
});

test("buildPalette gives the skills empty state when no shared skill exists", () => {
  const [, skills] = buildPalette({
    connectors: [],
    machines: [],
    skills: [{ id: "s2", name: "Private", ownerAgentId: "agent_1" }],
  });
  expect(skills?.items).toEqual([]);
  expect(skills?.empty).toEqual({
    href: "/skills",
    label: "Open Skills",
    text: "No skills yet.",
  });
});

test("buildPalette lists computers only, shown as Online or Offline", () => {
  const [, , computers] = buildPalette({
    connectors: [],
    machines: [
      machine({ computerStatus: "online", id: "m1", name: "Desk Mac" }),
      machine({ computerStatus: "offline", id: "m2", name: "Server" }),
      machine({ id: "m3", name: "Agent only", roles: ["agent_host"] }),
      machine({ id: "m4", name: "Revoked", status: "revoked" }),
    ],
    skills: [],
  });
  expect(computers?.items).toEqual([
    {
      detail: "Online",
      key: "computer:m1",
      label: "Desk Mac",
      setup: null,
      tool: { id: "m1", kind: "computer" },
    },
    {
      detail: "Offline",
      key: "computer:m2",
      label: "Server",
      setup: null,
      tool: { id: "m2", kind: "computer" },
    },
  ]);
  expect(computers?.empty).toBeNull();
});

test("buildPalette gives the computers empty state when none is enrolled", () => {
  const [, , computers] = buildPalette({
    connectors: [],
    machines: [machine({ roles: ["agent_host"] })],
    skills: [],
  });
  expect(computers?.items).toEqual([]);
  expect(computers?.empty).toEqual({
    href: "/settings/machines",
    label: "Add computer",
    text: "No computer is enrolled yet.",
  });
});

test("buildPalette adds the built-in browser as its own section", () => {
  const [, , , browser] = buildPalette({
    connectors: [],
    machines: [],
    skills: [],
  });
  expect(browser).toEqual({
    empty: null,
    items: [
      {
        detail: "Built in",
        key: "browser",
        label: "Browser",
        setup: null,
        tool: { kind: "browser" },
      },
    ],
    title: "Browser",
  });
});

test("connectChoices lists the agents a movable trigger is not wired to yet", () => {
  expect(connectChoices(graph, "trigger:h1")).toEqual([
    { key: "agent:bookkeeper", label: "Bookkeeper" },
  ]);
  expect(connectChoices(graph, "trigger:r1").map((c) => c.key)).toEqual([
    "agent:researcher",
    "agent:bookkeeper",
  ]);
});

test("connectChoices is empty for a trigger that cannot be moved and for non-triggers", () => {
  expect(connectChoices(graph, "trigger:m1")).toEqual([]);
  expect(connectChoices(graph, "agent:researcher")).toEqual([]);
});

test("deletableWiresFrom gives the canvas edge id of each deletable wire", () => {
  expect(deletableWiresFrom(graph, "trigger:h1")).toEqual([
    { edgeId: "trigger:trigger:h1:agent:researcher", label: "Researcher" },
  ]);
  expect(deletableWiresFrom(graph, "trigger:slack:T1")).toEqual([]);
  expect(deletableWiresFrom(graph, "agent:researcher")).toEqual([]);
});
