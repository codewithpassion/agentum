import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

/** Loads a task for a route: a signed-out caller goes to login, an unknown or hidden one is not found. */
export function loadTask(input: { runId: string } | { sessionId: string }) {
  return loadOrLogin(() => getTrpc().tasks.get.query(input), ["NOT_FOUND"]);
}
