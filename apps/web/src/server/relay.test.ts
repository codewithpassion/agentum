import { describe, expect, test } from "bun:test";
import { MachineRelay } from "./relay.ts";

describe("MachineRelay", () => {
  test("ping answers pong", () => {
    const relay = new MachineRelay({} as DurableObjectState, {} as Env);
    expect(relay.ping()).toEqual({ pong: true });
  });
});
