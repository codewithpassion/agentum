import {
  storageDeleteRequestSchema,
  storageGetRequestSchema,
  storageGetResultSchema,
  storageListRequestSchema,
  storageListResultSchema,
  storageSetRequestSchema,
} from "@repo/protocol/artifacts";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const artifactId = z.uuid();
const emptyOutput = z.strictObject({});

export const artifactStorageRouter = router({
  storageDelete: workspaceProcedure
    .input(storageDeleteRequestSchema.shape.params.extend({ artifactId }))
    .output(emptyOutput)
    .mutation(({ ctx, input }) =>
      ctx.services.artifactStorage.delete(ctx.principal, input)
    ),
  storageGet: workspaceProcedure
    .input(storageGetRequestSchema.shape.params.extend({ artifactId }))
    .output(storageGetResultSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifactStorage.get(ctx.principal, input)
    ),
  storageList: workspaceProcedure
    .input(storageListRequestSchema.shape.params.extend({ artifactId }))
    .output(storageListResultSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifactStorage.list(ctx.principal, input)
    ),
  storageSet: workspaceProcedure
    .input(storageSetRequestSchema.shape.params.extend({ artifactId }))
    .output(emptyOutput)
    .mutation(({ ctx, input }) =>
      ctx.services.artifactStorage.set(ctx.principal, input)
    ),
});
