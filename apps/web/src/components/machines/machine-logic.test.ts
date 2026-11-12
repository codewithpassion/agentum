import { describe, expect, test } from "bun:test";
import type { MachineRole, MachineStatus } from "@repo/db/shared";
import {
  canAddComputerRole,
  canRevoke,
  computerKind,
  computersOf,
  isDaemonOutdated,
  isRustMachine,
  newMachine,
  revokeMachine,
  roleRows,
  updatableVersions,
  visibleMachines,
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
    capabilities: { agentSdk: "claude-cli@2.1.300" },
    daemonVersion: "0.1.0+aaa1111" as string | null,
    roles: ["agent_host"] as MachineRole[],
    status: "online" as MachineStatus,
  };
  const old = ["0.1.0+aaa1111"];

  test("flags a client the server lists as older than the published one", () => {
    expect(isDaemonOutdated(machine, "0.1.0+bbb2222", old)).toBe(true);
  });

  test("leaves a client the server does not list alone, even if it differs", () => {
    expect(isDaemonOutdated(machine, "0.1.0+bbb2222", [])).toBe(false);
    expect(
      isDaemonOutdated(
        { ...machine, daemonVersion: "0.1.0+dev" },
        "0.1.0+bbb2222",
        old
      )
    ).toBe(false);
  });

  test("leaves a current client alone", () => {
    expect(isDaemonOutdated(machine, "0.1.0+aaa1111", old)).toBe(false);
  });

  test("says nothing without a published release or a reported version", () => {
    expect(isDaemonOutdated(machine, null, old)).toBe(false);
    expect(
      isDaemonOutdated(
        { ...machine, daemonVersion: null },
        "0.1.0+bbb2222",
        old
      )
    ).toBe(false);
  });

  test("ignores a revoked machine and a computer-only one with no version", () => {
    expect(
      isDaemonOutdated({ ...machine, status: "revoked" }, "0.2.0+x", old)
    ).toBe(false);
    expect(
      isDaemonOutdated({ ...machine, roles: ["computer"] }, "0.2.0+x", old)
    ).toBe(false);
  });

  test("says nothing about a retired TypeScript daemon", () => {
    expect(
      isDaemonOutdated({ ...machine, capabilities: {} }, "0.2.0+x", old)
    ).toBe(false);
  });
});

describe("updatableVersions", () => {
  test("lists each version once, from Rust machines that are not revoked", () => {
    const rust = {
      capabilities: { agentSdk: "claude-cli@2.1.300" },
      daemonVersion: "0.1.0+a" as string | null,
      roles: ["agent_host"] as MachineRole[],
      status: "online" as MachineStatus,
    };
    const computer = {
      capabilities: {},
      computerCapabilities: { clientVersion: "agentum-rs@0.1.0+b" },
      daemonVersion: null,
      roles: ["computer"] as MachineRole[],
      status: "offline" as MachineStatus,
    };
    expect(
      updatableVersions([
        rust,
        { ...rust },
        computer,
        {
          ...rust,
          daemonVersion: "0.1.0+c",
          status: "revoked" as MachineStatus,
        },
        { ...rust, capabilities: {}, daemonVersion: "0.1.0+d" },
      ])
    ).toEqual(["0.1.0+a", "0.1.0+b"]);
  });
});

test("computer-only Rust clients get the update hint", () => {
  const machine = {
    capabilities: {},
    computerCapabilities: { clientVersion: "agentum-rs@0.1.0+old" },
    daemonVersion: null,
    roles: ["computer"] as MachineRole[],
    status: "offline" as const,
  };
  const old = ["0.1.0+old"];
  expect(isDaemonOutdated(machine, "0.1.0+new", old)).toBe(true);
  expect(isDaemonOutdated(machine, "0.1.0+old", old)).toBe(false);
  expect(isDaemonOutdated({ ...machine, status: "revoked" }, "new", old)).toBe(
    false
  );
  expect(
    isDaemonOutdated(
      { ...machine, computerCapabilities: { clientVersion: "0.1.0+go" } },
      "new",
      old
    )
  ).toBe(false);
});

describe("isRustMachine", () => {
  test("recognises the Rust agent host and the Rust computer hello", () => {
    expect(
      isRustMachine({ capabilities: { agentSdk: "claude-cli@2.1.300" } })
    ).toBe(true);
    expect(
      isRustMachine({
        capabilities: {},
        computerCapabilities: { clientVersion: "agentum-rs@0.1.0+x" },
      })
    ).toBe(true);
  });

  test("refuses a machine from the retired clients", () => {
    expect(isRustMachine({ capabilities: {} })).toBe(false);
    expect(
      isRustMachine({
        capabilities: {},
        computerCapabilities: { clientVersion: "0.1.0+go" },
      })
    ).toBe(false);
  });
});

describe("visibleMachines", () => {
  const machines = [
    { id: "a", status: "online" as const },
    { id: "b", status: "revoked" as const },
  ];
  test("hides revoked machines unless asked", () => {
    expect(visibleMachines(machines, false).map((m) => m.id)).toEqual(["a"]);
    expect(visibleMachines(machines, true).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("newMachine", () => {
  const row = (
    id: string,
    status: "online" | "offline" | "revoked",
    computerStatus: "online" | "offline" = "offline"
  ) => ({ computerStatus, id, name: id, status });
  test("finds a new machine that has connected", () => {
    expect(
      newMachine([row("old", "online"), row("new", "online")], ["old"])?.id
    ).toBe("new");
  });
  test("a computer-only machine counts once its computer is online", () => {
    expect(newMachine([row("new", "offline", "online")], [])?.id).toBe("new");
  });
  test("a redeemed code that never connected is not connected", () => {
    expect(newMachine([row("new", "offline")], [])).toBeNull();
  });
  test("ignores known and revoked machines", () => {
    expect(
      newMachine([row("old", "online"), row("gone", "revoked")], ["old"])
    ).toBeNull();
  });
});
