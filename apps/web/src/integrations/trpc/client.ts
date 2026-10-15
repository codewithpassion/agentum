// The tRPC client for route loaders and components. In the browser it calls
// /api/trpc over HTTP. During SSR it calls the router in-process: a Worker
// fetching its own URL is a needless round trip, and relative URLs do not
// resolve on the server.
//
// No transformer, so results must be plain JSON: the in-process link hands
// SSR loaders the raw value, while the HTTP link JSON-encodes it. A Date
// would be a Date after SSR and a string after client-side navigation.
// Return ISO strings, or add superjson to both links and initTRPC.
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  createTRPCClient,
  httpBatchLink,
  unstable_localLink,
} from "@trpc/client";
import { createSsrContext } from "#/server/trpc/context";
import { type AppRouter, appRouter } from "#/server/trpc/router";

export const getTrpc = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        unstable_localLink({
          createContext: createSsrContext,
          router: appRouter,
        }),
      ],
    })
  )
  .client(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "/api/trpc" })],
    })
  );
