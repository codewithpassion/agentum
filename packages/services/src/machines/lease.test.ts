import { expect, test } from "bun:test";
import { createTakeoverLease } from "./lease.ts";
import {
  type ComputerControl,
  type MachineRelayPort,
  noopRelay,
  type TakeHumanLeaseOutcome,
} from "./types.ts";

const holding = (holder: ComputerControl["holder"]): ComputerControl => ({
  expiresAt: 1,
  holder,
});

const relayWith = (overrides: Partial<MachineRelayPort>): MachineRelayPort => ({
  ...noopRelay,
  ...overrides,
});

test("take gives the desktop to the person", async () => {
  const calls: unknown[] = [];
  const lease = createTakeoverLease(
    relayWith({
      takeHumanLease: (...args) => {
        calls.push(args);
        const taken: TakeHumanLeaseOutcome = {
          control: holding({ kind: "human", userId: "u1" }),
          ok: true,
        };
        return Promise.resolve(taken);
      },
    })
  );
  await lease.take("m1", "u1");
  expect(calls).toEqual([["m1", "u1"]]);
});

test("take refuses with a conflict and the relay's message", async () => {
  const lease = createTakeoverLease(relayWith({}));
  await expect(lease.take("m1", "u1")).rejects.toMatchObject({
    code: "conflict",
    message: "No computer is connected.",
  });
});

test("release lets go of the person who holds the desktop, whoever asks", async () => {
  const released: unknown[] = [];
  const lease = createTakeoverLease(
    relayWith({
      computerStatus: () =>
        Promise.resolve({
          ...{
            capabilities: null,
            connected: true,
            hostname: null,
            inFlightExec: 0,
            lastSeenAt: null,
            queued: 0,
            version: null,
            workdir: null,
          },
          control: holding({ kind: "human", userId: "holder" }),
        }),
      releaseHumanLease: (...args) => {
        released.push(args);
        return Promise.resolve({ clipboardCleared: true, released: true });
      },
    })
  );
  await lease.release("m1");
  expect(released).toEqual([["m1", "holder"]]);
});

test("release does nothing when nobody or an agent holds the desktop", async () => {
  const released: unknown[] = [];
  const status = (control: ComputerControl | null) =>
    Promise.resolve({
      capabilities: null,
      connected: true,
      control,
      hostname: null,
      inFlightExec: 0,
      lastSeenAt: null,
      queued: 0,
      version: null,
      workdir: null,
    });
  for (const control of [null, holding({ kind: "agent" })]) {
    const lease = createTakeoverLease(
      relayWith({
        computerStatus: () => status(control),
        releaseHumanLease: (...args) => {
          released.push(args);
          return Promise.resolve({ clipboardCleared: true, released: true });
        },
      })
    );
    // biome-ignore lint/performance/noAwaitInLoops: one case at a time
    await lease.release("m1");
  }
  expect(released).toEqual([]);
});
