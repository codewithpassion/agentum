import type { CloudRunnerPort } from "@repo/services/cloud/types";
import type { PiRun } from "./pi-run.ts";

/** The services' view of the cloud runner: one Durable Object per session, by session id. */
export const durableRunnerPort = (
  namespace: DurableObjectNamespace<PiRun>
): CloudRunnerPort => {
  const runnerOf = (sessionId: string) =>
    namespace.get(namespace.idFromName(sessionId));
  return {
    answered: (runId, sessionId, requestId) =>
      runnerOf(sessionId).requestAnswered(runId, requestId),
    cancel: (runId, sessionId) => runnerOf(sessionId).cancelRun(runId),
    start: (input) => runnerOf(input.run.sessionId).startRun(input),
  };
};
