import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import type { RuntimeAdapter } from "./types.ts";

/**
 * Answers every run with an echo of its input, so the lanes can test against a
 * run that goes end to end before a machine exists. It is the one adapter that
 * finishes the run inside `dispatch`. `createRunsService` registers it only
 * when `devFakeRuntime` is true.
 */
export const createFakeRuntime = (): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: async (_db, run, _agent, deps) => {
    await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
    const text = `Echo: ${run.inputText}`;
    await deps.ingestRunEvents(SYSTEM_PRINCIPAL, run.id, [
      { payload: { text }, seq: 1, type: "message.assistant" },
    ]);
    await deps.completeRun(SYSTEM_PRINCIPAL, run.id, { status: "done", text });
  },
  kind: "fake",
});
