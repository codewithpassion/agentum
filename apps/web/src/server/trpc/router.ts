import { TRPCError } from "@trpc/server";
import { accessRouter } from "./access-router.ts";
import { artifactSharesRouter } from "./artifact-shares-router.ts";
import { artifactStorageRouter } from "./artifact-storage-router.ts";
import { artifactsRouter } from "./artifacts-router.ts";
import { automationRouter } from "./automation-router.ts";
import { catalogRouter } from "./catalog-router.ts";
import { dreamRouter } from "./dream-router.ts";
import { mergeRouters, router, workspaceProcedure } from "./init.ts";
import { jobsRouter } from "./jobs-router.ts";
import { keysRouter } from "./keys-router.ts";
import { createLiveArtifactsRouter } from "./live-artifacts-router";
import { liveGuestsRouter } from "./live-guests-router";
import { mailRouter } from "./mail-router.ts";
import { memoryRouter } from "./memory-router.ts";
import { rosterRouter } from "./roster-router.ts";
import { runtimeRouter } from "./runtime-router.ts";
import { spendRouter } from "./spend-router.ts";
import { teamsRouter } from "./teams-router.ts";

// One router per lane, merged here. A lane edits its own file, not this one.
export const appRouter = mergeRouters(
  router({
    /**
     * The caller's user id and workspace id. The example workspace procedure:
     * it answers 401 unless the caller is a user whose organisation has a workspace row.
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
    catalog: catalogRouter,
    dream: dreamRouter,
    jobs: jobsRouter,
    keys: keysRouter,
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
    memory: memoryRouter,
    roster: rosterRouter,
    spend: spendRouter,
    teams: teamsRouter,
  })
);

export type AppRouter = typeof appRouter;
