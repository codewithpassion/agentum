import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { LiveArtifactsRouter } from "#/integrations/trpc/types";

/** The existing factory is the contract while L.7 mounts this namespace. Type-only
 * import keeps server/service code out of the browser. No root-router cast. */
type LiveRouter = LiveArtifactsRouter;
export type LiveOutputs = inferRouterOutputs<LiveRouter>;
export const liveApi = createTRPCClient<LiveRouter>({
  links: [
    (runtime) => {
      const link = httpBatchLink<LiveRouter>({ url: "/api/trpc" })(runtime);
      return ({ op, next }) =>
        link({ next, op: { ...op, path: `liveArtifacts.${op.path}` } });
    },
  ],
});
