import { describe, expect, test } from "bun:test";
import type { MachineRole, MachineStatus } from "@repo/db/shared";
import {
  canAddComputerRole,
  canRevoke,
  computerKind,
  computersOf,
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
