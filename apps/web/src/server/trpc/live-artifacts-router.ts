import { LIVE_DOC_MAX_BYTES } from "@repo/db/shared";
import { ensureDeckCellInputSchema } from "@repo/protocol/deck";
import { elementAskInputSchema } from "@repo/protocol/element-ask";
import { commentAnchorSchema } from "@repo/protocol/live";
import { liveAskInputSchema } from "@repo/services/live-artifacts/ask";
import type { LiveArtifactsWithAsk } from "@repo/services/live-artifacts/factory";
import { z } from "zod";
import type { Context } from "./context.ts";
import { router, workspaceProcedure } from "./init.ts";

const id = z.string().min(1).max(200);
const artifact = { artifactId: z.uuid() };
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const page = {
  cursor: id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
/** L.7 supplies the context selector when mounting; no production composition here.
 * Infrastructure admission and durable processors deliberately have no browser route. */
export const createLiveArtifactsRouter = (
  service: (ctx: Context) => LiveArtifactsWithAsk
) =>
  router({
    answered: workspaceProcedure
      .input(z.strictObject({ threadId: id }))
      .mutation(({ ctx, input }) =>
        service(ctx).answered(ctx.principal, input)
      ),
    ask: workspaceProcedure
      .input(liveAskInputSchema)
      .mutation(({ ctx, input }) => service(ctx).ask(ctx.principal, input)),
    askElement: workspaceProcedure
      .input(elementAskInputSchema)
      .mutation(({ ctx, input }) =>
        service(ctx).askElement(ctx.principal, input)
      ),
    changes: workspaceProcedure
      .input(z.strictObject({ ...artifact, ...page }))
      .query(({ ctx, input }) => service(ctx).changes(ctx.principal, input)),
    checkpoint: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          revision,
          state: z
            .array(z.number().int().min(0).max(255))
            .min(1)
            .max(16_000_000)
            .transform((value) => Uint8Array.from(value)),
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).checkpoint(ctx.principal, input)
      ),
    comment: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          anchor: commentAnchorSchema.optional(),
          body: z.string().trim().min(1).max(4096),
          requestId: id.optional(),
          threadId: id.optional(),
          toAgent: z.boolean().optional(),
        })
      )
      .mutation(({ ctx, input }) => service(ctx).comment(ctx.principal, input)),
    convertDoc: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          title: z.string().trim().min(1).max(120).optional(),
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).convertDoc(ctx.principal, input)
      ),
    createDeck: workspaceProcedure
      .input(
        z.strictObject({
          slides: z.array(z.string().max(2_000_000)).max(500).optional(),
          title: z.string().trim().min(1).max(120),
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).createDeck(ctx.principal, input)
      ),
    createDocument: workspaceProcedure
      .input(
        z.strictObject({
          markdown: z.string().max(LIVE_DOC_MAX_BYTES).optional(),
          title: z.string().trim().min(1).max(120),
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).createDocument(ctx.principal, input)
      ),
    decideSuggestion: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          decision: z.enum(["accept", "reject"]),
          suggestionId: id,
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).decideSuggestion(ctx.principal, input)
      ),
    embedSources: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          cursor: z.string().max(1400).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
      )
      .query(({ ctx, input }) =>
        service(ctx).embedSources(ctx.principal, input)
      ),
    ensureDeckCell: workspaceProcedure
      .input(ensureDeckCellInputSchema)
      .mutation(({ ctx, input }) =>
        service(ctx).ensureDeckCell(ctx.principal, input)
      ),
    exportMarkdown: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) =>
        service(ctx).exportMarkdown(ctx.principal, input)
      ),
    history: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) => service(ctx).history(ctx.principal, input)),
    importImage: workspaceProcedure
      .input(z.strictObject({ ...artifact, url: z.string().min(1).max(2048) }))
      .mutation(({ ctx, input }) =>
        service(ctx).importImage(ctx.principal, input)
      ),
    invalidateAccess: workspaceProcedure
      .input(z.strictObject({ ...artifact, participantId: id.optional() }))
      .mutation(({ ctx, input }) =>
        service(ctx).invalidateAccess(ctx.principal, input)
      ),
    join: workspaceProcedure
      .input(z.strictObject(artifact))
      .mutation(({ ctx, input }) => service(ctx).join(ctx.principal, input)),
    mentionMember: workspaceProcedure
      .input(z.strictObject({ ...artifact, email: z.email().max(254) }))
      .query(({ ctx, input }) =>
        service(ctx).mentionMember(ctx.principal, input)
      ),
    open: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) => service(ctx).open(ctx.principal, input)),
    ownBlobUrls: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) =>
        service(ctx).ownBlobUrls(ctx.principal, input)
      ),
    policy: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) => service(ctx).policy(ctx.principal, input)),
    recordChange: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          revFrom: revision,
          revTo: revision,
          summary: z.string().trim().min(1).max(4096),
          toolCallId: id,
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).recordChange(ctx.principal, input)
      ),
    remove: workspaceProcedure
      .input(z.strictObject(artifact))
      .mutation(({ ctx, input }) => service(ctx).remove(ctx.principal, input)),
    resolve: workspaceProcedure
      .input(z.strictObject({ threadId: id }))
      .mutation(({ ctx, input }) => service(ctx).resolve(ctx.principal, input)),
    resolveEmbed: workspaceProcedure
      .input(z.strictObject({ ...artifact, source: z.string().max(1200) }))
      .query(({ ctx, input }) =>
        service(ctx).resolveEmbed(ctx.principal, input)
      ),
    restore: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          requestId: id.optional(),
          version: z.number().int().positive(),
        })
      )
      .mutation(({ ctx, input }) => service(ctx).restore(ctx.principal, input)),
    retryCommentAsk: workspaceProcedure
      .input(z.strictObject({ ...artifact, commentId: id, threadId: id }))
      .mutation(({ ctx, input }) =>
        service(ctx).retryCommentAsk(ctx.principal, input)
      ),
    revertChange: workspaceProcedure
      .input(z.strictObject({ changeId: id }))
      .mutation(({ ctx, input }) =>
        service(ctx).revertChange(ctx.principal, input)
      ),
    selectAgent: workspaceProcedure
      .input(z.strictObject({ ...artifact, agentId: id }))
      .mutation(({ ctx, input }) =>
        service(ctx).selectAgent(ctx.principal, input)
      ),
    session: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) => service(ctx).session(ctx.principal, input)),
    setAudience: workspaceProcedure
      .input(
        z.strictObject({
          ...artifact,
          audience: z.enum(["private", "workspace"]),
        })
      )
      .mutation(({ ctx, input }) =>
        service(ctx).setAudience(ctx.principal, input)
      ),
    setSuggestionMode: workspaceProcedure
      .input(z.strictObject({ ...artifact, enabled: z.boolean() }))
      .mutation(({ ctx, input }) =>
        service(ctx).setSuggestionMode(ctx.principal, input)
      ),
    suggestions: workspaceProcedure
      .input(z.strictObject(artifact))
      .query(({ ctx, input }) =>
        service(ctx).suggestions(ctx.principal, input)
      ),
    threads: workspaceProcedure
      .input(
        z.strictObject({ ...artifact, ...page, inbox: z.boolean().optional() })
      )
      .query(({ ctx, input }) => service(ctx).threads(ctx.principal, input)),
  });
