/** Browser HTTP transport for acceptance fixtures, replacing only the SSR switch. */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../../trpc/router";
export const getTrpc = () =>
  createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] });
