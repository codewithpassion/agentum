import { beforeEach, describe, expect, test } from "bun:test";
import {
  createOutboundFixture,
  OUTBOUND_CONNECTION,
  type OutboundFixture,
} from "./outbound-fixture.ts";
import { member } from "./tasks-fixture.ts";

let f: OutboundFixture;

beforeEach(async () => {
  f = await createOutboundFixture();
});

describe("listPeers", () => {
  test("the owning agent's run sees its active connection as a peer", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const peers = await f.outbound.listPeers(call.principal);

    expect(peers).toEqual([
      {
        connectionId: "con_peer",
        description: "A fake peer",
        host: "peer.test",
        name: "Fake Peer",
        outboundPolicy: "auto",
        slug: "con_peer/fake-peer",
      },
    ]);
  });

  test("a run of another agent in the same workspace sees no peers", async () => {
    await f.connectPeer();
    const call = await f.callingRun();

    const peers = await f.outbound.listPeers({
      ...call.principal,
      agentId: "a-other",
    });

    expect(peers).toEqual([]);
  });

  test("a user principal and the system principal see no peers", async () => {
    await f.connectPeer();

    expect(await f.outbound.listPeers(member())).toEqual([]);
    expect(await f.outbound.listPeers(f.system)).toEqual([]);
  });

  test("an approve policy is listed with that policy, and off is not listed", async () => {
    await f.connectPeer({ outboundPolicy: "approve" });
    const call = await f.callingRun();

    const approved = await f.outbound.listPeers(call.principal);
    expect(approved.map((peer) => peer.outboundPolicy)).toEqual(["approve"]);

    await f.setConnection(OUTBOUND_CONNECTION, { outboundPolicy: "off" });

    expect(await f.outbound.listPeers(call.principal)).toEqual([]);
  });

  test("a revoked connection and one awaiting approval are not listed", async () => {
    await f.connectPeer({ id: "con_revoked", status: "revoked" });
    await f.connectPeer({ id: "con_pending", status: "needs_approval" });
    const call = await f.callingRun();

    expect(await f.outbound.listPeers(call.principal)).toEqual([]);
  });

  test("an inbound connection is not listed", async () => {
    await f.connectPeer({ peerKind: "a2a_inbound" });
    const call = await f.callingRun();

    expect(await f.outbound.listPeers(call.principal)).toEqual([]);
  });

  test("a connection whose destination is not approved is not listed", async () => {
    await f.connectPeer();
    await f.setConnection(OUTBOUND_CONNECTION, {
      peerOrigin: "https://other.test",
    });
    const call = await f.callingRun();

    expect(await f.outbound.listPeers(call.principal)).toEqual([]);
  });

  test("two connections of the same agent are both listed, oldest first", async () => {
    await f.connectPeer({
      createdAt: "2026-11-01T10:00:00.000Z",
      id: "con_newer",
      peerLabel: "Newer Peer",
    });
    await f.connectPeer({
      createdAt: "2026-11-01T09:00:00.000Z",
      id: "con_older",
      peerLabel: "Older Peer",
    });
    const call = await f.callingRun();

    const peers = await f.outbound.listPeers(call.principal);

    expect(peers.map((peer) => peer.connectionId)).toEqual([
      "con_older",
      "con_newer",
    ]);
    expect(peers.map((peer) => peer.slug)).toEqual([
      "con_older/older-peer",
      "con_newer/newer-peer",
    ]);
  });
});
