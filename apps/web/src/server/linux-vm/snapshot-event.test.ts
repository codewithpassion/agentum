import { describe, expect, test } from "bun:test";
import type { EventInput, EventsService } from "@repo/services/events";
import type { RunsService } from "@repo/services/runs";
import { recordSnapshot } from "./snapshot-event.ts";
import type { VmEgressRun, WorkspaceSnapshot } from "./vm-port.ts";

const run: VmEgressRun = {
  agentId: "agent-1",
  runId: "run-1",
  workspaceId: "ws-1",
};

const setup = () => {
  const appended: EventInput[] = [];
  const looked: string[] = [];
  const events = {
    append: (input: EventInput) => {
      appended.push(input);
      return Promise.resolve(
        {} as Awaited<ReturnType<EventsService["append"]>>
      );
    },
  };
  const runs = {
    getRun: (_principal: unknown, runId: string) => {
      looked.push(runId);
      return Promise.resolve({ sessionId: "session-1" } as Awaited<
        ReturnType<RunsService["getRun"]>
      >);
    },
  };
  return { appended, looked, services: { events, runs } };
};

describe("recordSnapshot", () => {
  test("a successful snapshot lands as one append on the run's session", async () => {
    const { appended, looked, services } = setup();
    const snapshot: WorkspaceSnapshot = { bytes: 2048, ms: 310, ok: true };

    await recordSnapshot(services, run, snapshot);

    expect(looked).toEqual(["run-1"]);
    expect(appended).toEqual([
      {
        actor: { id: "linux-vm", kind: "system" },
        agentId: "agent-1",
        payload: { bytes: 2048, ms: 310, ok: true },
        runId: "run-1",
        sessionId: "session-1",
        type: "workspace.snapshot",
        workspaceId: "ws-1",
      },
    ]);
  });

  test("a failed snapshot carries its error", async () => {
    const { appended, services } = setup();

    await recordSnapshot(services, run, {
      bytes: 0,
      error: "restore failed: container gone",
      ms: 95,
      ok: false,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toEqual({
      bytes: 0,
      error: "restore failed: container gone",
      ms: 95,
      ok: false,
    });
  });

  test("a warning is carried", async () => {
    const { appended, services } = setup();

    await recordSnapshot(services, run, {
      bytes: 900_000_000,
      ms: 1200,
      ok: true,
      warning: "home folder is over the soft cap",
    });

    expect(appended[0]?.payload).toEqual({
      bytes: 900_000_000,
      ms: 1200,
      ok: true,
      warning: "home folder is over the soft cap",
    });
  });

  test("absent error and warning are not keys in the payload", async () => {
    const { appended, services } = setup();

    await recordSnapshot(services, run, { bytes: 1, ms: 2, ok: true });

    const payload = appended[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(["bytes", "ms", "ok"]);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
