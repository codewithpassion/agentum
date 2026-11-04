import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

interface Limiter {
  limit: (input: { key: string }) => Promise<{ success: boolean }>;
}
export interface DictationLimits {
  polish: Limiter;
  transcribe: Limiter;
}
export const dictationWithinLimit = async (
  limits: DictationLimits,
  kind: "transcribe" | "polish",
  user: string
): Promise<boolean> => {
  // Existing bindings are fixed at 30/min (SHARE_OPEN_LIMIT) and 300/min (APP_API_LIMIT).
  // Three overflow buckets give 90 ASR calls. Fifteen budget units give 20 polish calls.
  // Namespaced keys isolate these budgets from other routes; no new binding or transcript storage.
  if (kind === "transcribe") {
    for (let bucket = 0; bucket < 3; bucket += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Consume overflow buckets only after the previous is full.
      const result = await limits.transcribe.limit({
        key: `dictation:transcribe:${user}:${bucket}`,
      });
      if (result.success) {
        return true;
      }
    }
    return false;
  }
  const results = await Promise.all(
    Array.from({ length: 15 }, () =>
      limits.polish.limit({ key: `dictation:polish:${user}` })
    )
  );
  return results.every((result) => result.success);
};
const limited = workspaceProcedure.use(async ({ ctx, path, next }) => {
  const kind = path.endsWith("transcribe") ? "transcribe" : "polish";
  if (
    ctx.services.dictationLimits &&
    !(await dictationWithinLimit(
      ctx.services.dictationLimits,
      kind,
      `${ctx.principal.workspaceId}:${ctx.principal.userId}`
    ))
  ) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many dictation requests. Try again in a minute.",
    });
  }
  return next();
});
export const dictationRouter = router({
  polish: limited
    .input(z.strictObject({ text: z.string().min(1).max(100_000) }))
    .mutation(({ ctx, input }) =>
      ctx.services.dictation.polish(ctx.principal, input)
    ),
  status: workspaceProcedure.query(({ ctx }) =>
    ctx.services.dictation.status(ctx.principal)
  ),
  transcribe: limited
    .input(
      z.strictObject({ audio: z.string().max(682_728), final: z.boolean() })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.dictation.transcribe(ctx.principal, input)
    ),
});
