import { expect, test } from "bun:test";
import {
  type ConnectionLike,
  clipMessage,
  directionsOn,
  hermesConfigYaml,
  hermesUrlOfCardUrl,
  lastActivity,
  peerHost,
  revokeWords,
  sortConnections,
  wideningWarning,
  widens,
} from "./connections-logic.ts";

const connection = (overrides: Partial<ConnectionLike>): ConnectionLike => ({
  createdAt: "2026-11-01T10:00:00.000Z",
  id: "con_1",
  inboundPolicy: "approve",
  lastInAt: null,
  lastOutAt: null,
  outboundPolicy: "approve",
  peerKind: "harbourmaster",
  peerLabel: "Y",
  peerOrigin: "https://hm.test",
  pendingOrigin: null,
  status: "active",
  ...overrides,
});

test("pending approvals sort first, ended connections last", () => {
  const sorted = sortConnections([
    connection({ id: "old", status: "active" }),
    connection({ id: "gone", status: "revoked" }),
    connection({
      createdAt: "2026-10-01T00:00:00.000Z",
      id: "wait",
      status: "needs_approval",
    }),
    connection({
      createdAt: "2026-11-02T00:00:00.000Z",
      id: "new",
      status: "active",
    }),
  ]);
  expect(sorted.map((row) => row.id)).toEqual(["wait", "new", "old", "gone"]);
});

test("directions follow the kind of peer and the policies", () => {
  expect(directionsOn(connection({}))).toEqual(["Receives", "Sends"]);
  expect(
    directionsOn(
      connection({ inboundPolicy: "off", peerKind: "harbourmaster" })
    )
  ).toEqual(["Sends"]);
  expect(directionsOn(connection({ peerKind: "a2a_inbound" }))).toEqual([
    "Receives",
  ]);
  expect(directionsOn(connection({ peerKind: "a2a_outbound" }))).toEqual([
    "Sends",
  ]);
});

test("the host shows the origin awaiting approval before the stored one", () => {
  expect(peerHost(connection({}))).toBe("hm.test");
  expect(
    peerHost(connection({ pendingOrigin: "https://moved.example:8443" }))
  ).toBe("moved.example:8443");
  expect(peerHost(connection({ peerOrigin: null }))).toBeNull();
});

test("last activity is the later of the two", () => {
  expect(lastActivity({ lastInAt: null, lastOutAt: null })).toBeNull();
  expect(
    lastActivity({
      lastInAt: "2026-11-01T10:00:00.000Z",
      lastOutAt: "2026-11-01T11:00:00.000Z",
    })
  ).toBe("2026-11-01T11:00:00.000Z");
});

test("only the widening moves carry a warning, and the tool one names shell commands", () => {
  expect(wideningWarning({ inboundPolicy: "off" })).toBeNull();
  expect(wideningWarning({ toolPolicy: "ask" })).toBeNull();
  expect(wideningWarning({ inboundPolicy: "auto" })).toContain(
    "no one reading"
  );
  expect(wideningWarning({ toolPolicy: "agent_rules" })).toContain(
    "shell commands"
  );
});

test("the Hermes block points at the interface base and quotes the key", () => {
  const cardUrl = "https://hm.test/a2a/pub123/.well-known/agent-card.json";
  expect(hermesUrlOfCardUrl(cardUrl)).toBe("https://hm.test/a2a/pub123");
  expect(
    hermesConfigYaml({ cardUrl, name: "Support", token: "hm_a2a_secret" })
  ).toBe(
    [
      "a2a_agents:",
      '  "Support":',
      '    url: "https://hm.test/a2a/pub123"',
      "    auth:",
      "      type: bearer",
      '      token: "hm_a2a_secret"',
    ].join("\n")
  );
});

const current = {
  hourlyLimit: 100,
  inboundPolicy: "approve",
  outboundPolicy: "approve",
  toolPolicy: "ask",
} as const;

test("widens: a higher inbound or outbound step widens, a lower one narrows", () => {
  expect(widens(current, { inboundPolicy: "auto" })).toBe(true);
  expect(widens(current, { inboundPolicy: "off" })).toBe(false);
  expect(widens(current, { outboundPolicy: "auto" })).toBe(true);
  expect(widens(current, { outboundPolicy: "off" })).toBe(false);
});

test("widens: agent rules in place of ask widens, ask narrows", () => {
  expect(widens(current, { toolPolicy: "agent_rules" })).toBe(true);
  expect(widens(current, { toolPolicy: "ask" })).toBe(false);
});

test("widens: a higher hourly limit widens, a lower one narrows", () => {
  expect(widens(current, { hourlyLimit: 101 })).toBe(true);
  expect(widens(current, { hourlyLimit: 99 })).toBe(false);
  expect(widens(current, { hourlyLimit: 100 })).toBe(false);
});

test("widens: the same step as now, or no field, does not widen", () => {
  expect(widens(current, { inboundPolicy: "approve" })).toBe(false);
  expect(widens(current, {})).toBe(false);
});

test("widens compares with the current value, not the default", () => {
  const open = {
    ...current,
    inboundPolicy: "auto",
    toolPolicy: "agent_rules",
  } as const;
  expect(widens(open, { inboundPolicy: "approve" })).toBe(false);
  expect(widens(open, { inboundPolicy: "auto" })).toBe(false);
  expect(widens(open, { toolPolicy: "ask" })).toBe(false);
});

test("widens: a change of several fields widens when any one of them does", () => {
  expect(widens(current, { hourlyLimit: 50, outboundPolicy: "auto" })).toBe(
    true
  );
  expect(widens(current, { hourlyLimit: 50, inboundPolicy: "off" })).toBe(
    false
  );
});

test("clipMessage keeps a short message as it is", () => {
  expect(clipMessage("hello")).toBe("hello");
  const exact = "a".repeat(300);
  expect(clipMessage(exact)).toBe(exact);
});

test("clipMessage cuts at 300 characters and adds an ellipsis", () => {
  const clipped = clipMessage("a".repeat(301));
  expect(clipped).toBe(`${"a".repeat(300)}…`);
});

test("clipMessage counts characters, so it never splits a surrogate pair", () => {
  const emoji = "😀";
  const clipped = clipMessage(emoji.repeat(301));
  expect(clipped).toBe(`${emoji.repeat(300)}…`);
});

test("the revoke words say what stops and how to come back, by kind of peer", () => {
  const base = {
    agentName: "Support",
    peerLabel: "Sam",
    status: "active" as const,
  };
  const invite = revokeWords({ ...base, peerKind: "harbourmaster" });
  const key = revokeWords({ ...base, peerKind: "a2a_inbound" });
  const outside = revokeWords({ ...base, peerKind: "a2a_outbound" });

  expect(invite).toContain("Support can no longer message it");
  expect(invite).toContain("new invite");
  expect(key).not.toContain("can no longer message it");
  expect(key).toContain("new key");
  expect(outside).toContain("Support can no longer message Sam");
  expect(outside).toContain("add it again");
});
