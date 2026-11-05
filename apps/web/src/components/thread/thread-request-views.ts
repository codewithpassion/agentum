import type { RequestView } from "../requests/request-card-logic.ts";
import { requestViews, type TaskLive } from "../task/task-state.ts";

/** The header's live requests stay scoped to its run; the conversation includes history. */
export function threadRequestViews(
  events: TaskLive["events"],
  current: ReadonlyMap<string, RequestView>
): ReadonlyMap<string, RequestView> {
  const runs = new Set(
    events
      .filter((event) => event.type === "request.opened")
      .map((event) => event.runId)
  );
  const views = new Map<string, RequestView>();
  for (const runId of runs) {
    if (runId === null) {
      continue;
    }
    const historical = requestViews({
      events,
      needsRequests: false,
      records: [],
      runId,
      runStatus: "done",
      sessionId: "",
      settled: {},
    });
    for (const [id, view] of historical) {
      views.set(id, view);
    }
  }
  for (const [id, view] of current) {
    views.set(id, view);
  }
  return views;
}
