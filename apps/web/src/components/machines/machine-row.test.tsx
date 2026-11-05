import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineRecord } from "#/integrations/trpc/types";
import { MachineRow } from "./machine-row";

const noop = () => undefined;

test("a computer-only Rust machine displays its update command", () => {
  const machine: MachineRecord = {
    capabilities: {},
    computerCapabilities: { clientVersion: "agentum-rs@0.1.0+old" },
    computerLastSeenAt: null,
    computerStatus: "offline",
    createdAt: "2026-11-06T00:00:00Z",
    daemonVersion: null,
    enrolledBy: "user",
    id: "m",
    lastSeenAt: null,
    name: "Office",
    roles: ["computer"],
    singleUser: false,
    status: "offline",
    workspaceId: "workspace",
  };
  const html = renderToStaticMarkup(
    <MachineRow
      latestDaemonVersion="0.1.0+go"
      latestRustVersion="0.1.0+new"
      machine={machine}
      onAddComputer={noop}
      onRevoke={noop}
      origin="https://example.com"
    />
  );
  expect(html).toContain("Client update available (0.1.0+new)");
  expect(html).toContain("install-agentum.sh");
  expect(html).not.toContain("/install.sh");
});
