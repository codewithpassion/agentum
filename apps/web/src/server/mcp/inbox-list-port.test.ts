import { expect, test } from "bun:test";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

interface ListCall {
  input: unknown;
  principal: Principal;
}

const user: Principal = {
  kind: "user",
  userId: "user_1",
  via: "session",
  workspaceId: "ws_1",
};
const run: Principal = {
  agentId: "agent_lead",
  kind: "run",
  runId: "run_1",
  workspaceId: "ws_1",
};

/** Services that record `inbox.listThreads` and answer `teamLead.roomRun` with `room`. */
const stubServices = (
  calls: ListCall[],
  room: { teamId: string } | null
): Services =>
  ({
    inbox: {
      listThreads: (principal: Principal, input?: unknown) => {
        calls.push({ input, principal });
        return Promise.resolve([]);
      },
    },
    teamLead: { roomRun: () => Promise.resolve(room) },
  }) as unknown as Services;

test("inboxList from a lead's room run lists that room's topics", async () => {
  const calls: ListCall[] = [];
  const ports = createMcpPorts({
    principal: run,
    services: stubServices(calls, { teamId: "team_1" }),
  });

  await ports.inboxList();

  expect(calls).toEqual([{ input: { teamId: "team_1" }, principal: run }]);
});

test("inboxList from a run outside a room, or from a person, lists the workspace", async () => {
  const calls: ListCall[] = [];
  const outsideRoom = createMcpPorts({
    principal: run,
    services: stubServices(calls, null),
  });
  const person = createMcpPorts({
    principal: user,
    services: stubServices(calls, { teamId: "team_1" }),
  });

  await outsideRoom.inboxList();
  await person.inboxList();

  expect(calls.map((call) => call.input)).toEqual([undefined, undefined]);
});
