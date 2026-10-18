import type { EventsService } from "@repo/services/events";
import type { RunsService } from "@repo/services/runs";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { VmEgressRun, WorkspaceSnapshot } from "./vm-port.ts";

/** Puts one restore or snapshot of the home folder on the run as a `workspace.snapshot` event. */
export const recordSnapshot = async (
  services: {
    events: Pick<EventsService, "append">;
    runs: Pick<RunsService, "getRun">;
  },
  run: VmEgressRun,
  snapshot: WorkspaceSnapshot
): Promise<void> => {
  const { sessionId } = await services.runs.getRun(SYSTEM_PRINCIPAL, run.runId);
  const payload: Record<string, string | number | boolean> = {
    bytes: snapshot.bytes,
    ms: snapshot.ms,
    ok: snapshot.ok,
  };
  if (snapshot.error !== undefined) {
    payload.error = snapshot.error;
  }
  if (snapshot.warning !== undefined) {
    payload.warning = snapshot.warning;
  }
  await services.events.append({
    actor: { id: "linux-vm", kind: "system" },
    agentId: run.agentId,
    payload,
    runId: run.runId,
    sessionId,
    type: "workspace.snapshot",
    workspaceId: run.workspaceId,
  });
};
