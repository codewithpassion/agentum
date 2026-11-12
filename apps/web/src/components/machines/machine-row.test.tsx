import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MachineRecord } from "#/integrations/trpc/types";
import { MachineRow } from "./machine-row";

const noop = () => undefined;

const machineWith = (doctorProblems: MachineRecord["doctorProblems"]) => ({
  capabilities: {},
  computerCapabilities: null,
  computerLastSeenAt: null,
  computerStatus: null,
  createdAt: "2026-11-06T00:00:00Z",
  daemonVersion: "agentum-rs@0.1.0+new",
  doctorProblems,
  enrolledBy: "user",
  id: "m",
  lastSeenAt: null,
  name: "Office",
  roles: ["agent_host" as const],
  singleUser: false,
  status: "online" as const,
  workspaceId: "workspace",
});

const renderRow = (machine: MachineRecord) =>
  renderToStaticMarkup(
    <MachineRow
      latestVersion={null}
      machine={machine}
      onAddComputer={noop}
      onRevoke={noop}
      origin={null}
      outdatedVersions={[]}
    />
  );

test("a machine row lists the failed checks with their fix", () => {
  const html = renderRow(
    machineWith([
      {
        message: "Check claude login\nFix: sudo -iu dom claude auth login",
        name: "claude login",
      },
    ])
  );
  expect(html).toContain("This machine needs attention");
  expect(html).toContain("claude login");
  expect(html).toContain("claude auth login");
});

test("a machine row with a clean doctor shows no warning", () => {
  expect(renderRow(machineWith([]))).not.toContain("needs attention");
  expect(renderRow(machineWith(null))).not.toContain("needs attention");
});

test("a computer-only Rust machine displays its update command", () => {
  const machine: MachineRecord = {
    capabilities: {},
    computerCapabilities: { clientVersion: "agentum-rs@0.1.0+old" },
    computerLastSeenAt: null,
    computerStatus: "offline",
    createdAt: "2026-11-06T00:00:00Z",
    daemonVersion: null,
    doctorProblems: null,
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
      latestVersion="0.1.0+new"
      machine={machine}
      onAddComputer={noop}
      onRevoke={noop}
      origin="https://example.com"
      outdatedVersions={["0.1.0+old"]}
    />
  );
  expect(html).toContain("Client update available (0.1.0+new)");
  expect(html).toContain("install-agentum.sh");
  expect(html).not.toContain("/install.sh");
});
