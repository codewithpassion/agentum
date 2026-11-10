import { notFound, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";

/** True for a tRPC error with this code, e.g. `UNAUTHORIZED` or `NOT_FOUND`. */
export const hasTrpcCode = (error: unknown, code: string): boolean =>
  error instanceof TRPCClientError && error.data?.code === code;

/**
 * Runs a route loader's reads. A signed-out caller (a 401 from tRPC) goes to
 * `/login`. A tRPC error with a code in `notFoundOn` becomes the route's not
 * found page. Every other error reaches the route's error boundary.
 */
export async function loadOrLogin<T>(
  load: () => Promise<T>,
  notFoundOn: readonly string[] = []
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (hasTrpcCode(error, "UNAUTHORIZED")) {
      throw redirect({ to: "/login" });
    }
    if (notFoundOn.some((code) => hasTrpcCode(error, code))) {
      throw notFound();
    }
    throw error;
  }
}
