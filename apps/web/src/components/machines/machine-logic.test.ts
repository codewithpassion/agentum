import { describe, expect, test } from "bun:test";
import type { MachineRole, MachineStatus } from "@repo/db/shared";
import {
  canAddComputerRole,
  canRevoke,
  computerKind,
  computersOf,
  isDaemonOutdated,
  revokeMachine,
  roleRows,
} from "./machine-logic.ts";

describe("roleRows", () => {
  test("gives each role its own status", () => {
    expect(
      roleRows({
        computerStatus: "offline",
        roles: ["agent_host", "computer"],
        status: "online",
      })
    ).toEqual([
      {
        label: "Runs the agent",
        role: "agent_host",
        status: "Online",
        tone: "good",
      },
      { label: "Computer", role: "computer", status: "Offline", tone: "muted" },
    ]);
  });

  test("a revoked machine is revoked in both roles", () => {
    const rows = roleRows({
      computerStatus: "offline",
      roles: ["agent_host", "computer"],
      status: "revoked",
    });
    expect(rows.map((row) => row.status)).toEqual(["Revoked", "Revoked"]);
  });

  test("a computer-only machine shows one role", () => {
    expect(
      roleRows({
        computerStatus: "online",
        roles: ["computer"],
        status: "offline",
      })
    ).toEqual([
      { label: "Computer", role: "computer", status: "Online", tone: "good" },
    ]);
  });
});

describe("computerKind", () => {
  test("reads the desktop flag from the hello", () => {
    expect(computerKind({ computerCapabilities: { desktop: true } })).toBe(
      "Desktop"
    );
    expect(computerKind({ computerCapabilities: { desktop: false } })).toBe(
      "Headless"
    );
    expect(computerKind({ computerCapabilities: {} })).toBe("Headless");
  });

  test("is null before the first hello", () => {
    expect(computerKind({ computerCapabilities: null })).toBeNull();
  });
});

describe("canAddComputerRole", () => {
  test("only a live daemon machine without a computer", () => {
    expect(
      canAddComputerRole({ roles: ["agent_host"], status: "online" })
    ).toBe(true);
    expect(
      canAddComputerRole({
        roles: ["agent_host", "computer"],
        status: "online",
      })
    ).toBe(false);
    expect(canAddComputerRole({ roles: ["computer"], status: "offline" })).toBe(
      false
    );
    expect(
      canAddComputerRole({ roles: ["agent_host"], status: "revoked" })
    ).toBe(false);
  });
});

describe("computersOf", () => {
  test("keeps machines with a computer role that are not revoked", () => {
    const machines: {
      id: string;
      roles: MachineRole[];
      status: MachineStatus;
    }[] = [
      { id: "a", roles: ["agent_host"], status: "online" },
      { id: "b", roles: ["computer"], status: "offline" },
      { id: "c", roles: ["agent_host", "computer"], status: "revoked" },
    ];
    expect(computersOf(machines).map((machine) => machine.id)).toEqual(["b"]);
  });
});

describe("canRevoke", () => {
  test("offers Revoke for a machine that is not revoked", () => {
    expect(canRevoke({ status: "online" })).toBe(true);
    expect(canRevoke({ status: "offline" })).toBe(true);
  });

  test("hides Revoke once the machine is revoked", () => {
    expect(canRevoke({ status: "revoked" })).toBe(false);
  });
});

describe("revokeMachine", () => {
  test("calls revoke with the machine id and reports no error", async () => {
    const calls: { machineId: string }[] = [];
    const error = await revokeMachine((input) => {
      calls.push(input);
      return Promise.resolve();
    }, "m1");
    expect(calls).toEqual([{ machineId: "m1" }]);
    expect(error).toBeNull();
  });

  test("returns the failure text when revoke throws", async () => {
    const failing = () => Promise.reject(new Error("Machine not found"));
    expect(await revokeMachine(failing, "m1")).toBe("Machine not found");
    expect(await revokeMachine(() => Promise.reject("x"), "m1")).toBe(
      "Something went wrong."
    );
  });
});

describe("isDaemonOutdated", () => {
  const machine = {
    daemonVersion: "0.1.0+aaa1111" as string | null,
    roles: ["agent_host"] as MachineRole[],
    status: "online" as MachineStatus,
  };

  test("flags a daemon that differs from the published one", () => {
    expect(isDaemonOutdated(machine, "0.1.0+bbb2222")).toBe(true);
    expect(
      isDaemonOutdated({ ...machine, daemonVersion: "0.1.0" }, "0.1.0+bbb2222")
    ).toBe(true);
  });

  test("leaves a current daemon alone", () => {
    expect(isDaemonOutdated(machine, "0.1.0+aaa1111")).toBe(false);
  });

  test("says nothing without a published release or a reported version", () => {
    expect(isDaemonOutdated(machine, null)).toBe(false);
    expect(
      isDaemonOutdated({ ...machine, daemonVersion: null }, "0.1.0+bbb2222")
    ).toBe(false);
  });

  test("ignores a revoked machine and a computer-only one", () => {
    expect(isDaemonOutdated({ ...machine, status: "revoked" }, "0.2.0+x")).toBe(
      false
    );
    expect(
      isDaemonOutdated({ ...machine, roles: ["computer"] }, "0.2.0+x")
    ).toBe(false);
  });
});

test("Rust clients compare only the Rust product's version", () => {
  const machine = {
    capabilities: { agentSdk: "claude-cli@2.1.300" },
    daemonVersion: "0.1.0+rust",
    roles: ["agent_host"] as const,
    status: "online" as const,
  };
  const mutable = { ...machine, roles: [...machine.roles] };
  expect(isDaemonOutdated(mutable, "0.1.0+old", "0.1.0+rust")).toBe(false);
  expect(isDaemonOutdated(mutable, "0.1.0+rust", "0.1.0+new")).toBe(true);
  expect(isDaemonOutdated(mutable, "0.1.0+old", null)).toBe(false);
});

test("computer-only Rust clients get the Rust update hint", () => {
  const machine = {
    capabilities: {},
    computerCapabilities: { clientVersion: "agentum-rs@0.1.0+old" },
    daemonVersion: null,
    roles: ["computer"] as MachineRole[],
    status: "offline" as const,
  };
  expect(isDaemonOutdated(machine, "0.1.0+go", "0.1.0+new")).toBe(true);
  expect(isDaemonOutdated(machine, "0.1.0+go", "0.1.0+old")).toBe(false);
  expect(isDaemonOutdated({ ...machine, status: "revoked" }, null, "new")).toBe(
    false
  );
  expect(
    isDaemonOutdated(
      { ...machine, computerCapabilities: { clientVersion: "0.1.0+go" } },
      "new",
      "new"
    )
  ).toBe(false);
});
