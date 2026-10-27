import { TRPCError } from "@trpc/server";
import { accessRouter } from "./access-router.ts";
import { artifactSharesRouter } from "./artifact-shares-router.ts";
import { artifactStorageRouter } from "./artifact-storage-router.ts";
import { artifactsRouter } from "./artifacts-router.ts";
import { automationRouter } from "./automation-router.ts";
import { mergeRouters, router, workspaceProcedure } from "./init.ts";
import { createLiveArtifactsRouter } from "./live-artifacts-router";
import { liveGuestsRouter } from "./live-guests-router";
import { mailRouter } from "./mail-router.ts";
import { runtimeRouter } from "./runtime-router.ts";

// One router per lane, merged here. A lane edits its own file, not this one.
export const appRouter = mergeRouters(
  router({
    /**
     * The caller's user id and workspace id. The example workspace procedure:
     * it answers 401 unless the caller is a user in an allowed organisation.
     */
    me: workspaceProcedure.query(({ ctx }) => ({
      userId: ctx.principal.userId,
      workspaceId: ctx.principal.workspaceId,
    })),
  }),
  runtimeRouter,
  accessRouter,
  automationRouter,
  mailRouter,
  router({
    artifacts: mergeRouters(
      artifactsRouter,
      artifactSharesRouter,
      artifactStorageRouter
    ),
    liveArtifacts: createLiveArtifactsRouter((ctx) => {
      if (!ctx.services.liveArtifacts) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Live artifacts are unavailable",
        });
      }
      return ctx.services.liveArtifacts;
    }),
    liveGuests: liveGuestsRouter,
  })
);

export type AppRouter = typeof appRouter;
