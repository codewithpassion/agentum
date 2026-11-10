import { notFound, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { getTrpc } from "#/integrations/trpc/client";

/** Loads a task for a route: a signed-out caller goes to login, an unknown or hidden one is not found. */
export async function loadTask(
  input: { runId: string } | { sessionId: string }
) {
  try {
    return await getTrpc().tasks.get.query(input);
  } catch (error) {
    if (
      error instanceof TRPCClientError &&
      error.data?.code === "UNAUTHORIZED"
    ) {
      throw redirect({ to: "/login" });
    }
    if (error instanceof TRPCClientError && error.data?.code === "NOT_FOUND") {
      throw notFound();
    }
    throw error;
  }
}
