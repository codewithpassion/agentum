import { MODEL_PROVIDERS, type ModelProvider } from "@repo/db/shared";
import { agentCreateSchema, agentUpdateSchema } from "@repo/services/agents";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const idInput = z.strictObject({ id: z.string().min(1) });

/** Object.fromEntries types its result as an index signature, so check that every provider is present. */
const isEveryProvider = (
  flags: Record<string, boolean>
): flags is Record<ModelProvider, boolean> =>
  MODEL_PROVIDERS.every((provider) => typeof flags[provider] === "boolean");

/** One boolean per provider. The caller passes the check, so no key or hint is read here. */
const providerFlags = async (
  configured: (provider: ModelProvider) => Promise<boolean>
): Promise<Record<ModelProvider, boolean>> => {
  const entries = await Promise.all(
    MODEL_PROVIDERS.map(
      async (provider) => [provider, await configured(provider)] as const
    )
  );
  const flags = Object.fromEntries(entries);
  if (!isEveryProvider(flags)) {
    throw new Error("Every model provider needs a key flag");
  }
  return flags;
};

export const agentsRouter = router({
  archive: workspaceProcedure
    .input(idInput)
    .mutation(({ ctx, input }) =>
      ctx.services.agents.archive(ctx.principal, input.id)
    ),
  create: workspaceProcedure
    .input(agentCreateSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agents.create(ctx.principal, input)
    ),
  get: workspaceProcedure
    .input(idInput)
    .query(({ ctx, input }) =>
      ctx.services.agents.get(ctx.principal, input.id)
    ),
  list: workspaceProcedure
    .input(z.strictObject({ includeArchived: z.boolean().optional() }))
    .query(({ ctx, input }) => ctx.services.agents.list(ctx.principal, input)),
  providerKeys: workspaceProcedure.query(({ ctx }) =>
    providerFlags(async (provider) => {
      const status = await ctx.services.modelKeys.status(
        ctx.principal,
        provider
      );
      return status.configured;
    })
  ),
  update: workspaceProcedure
    .input(z.strictObject({ id: z.string().min(1), patch: agentUpdateSchema }))
    .mutation(({ ctx, input }) =>
      ctx.services.agents.update(ctx.principal, input.id, input.patch)
    ),
});
