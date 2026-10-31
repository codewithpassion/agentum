import { expect, test } from "bun:test";
import {
  type ConnectionLike,
  directionsOn,
  hermesConfigYaml,
  hermesUrlOfCardUrl,
  lastActivity,
  peerHost,
  sortConnections,
  wideningWarning,
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
