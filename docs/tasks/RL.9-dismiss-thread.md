---
id: RL.9
title: "Dismiss an inbox thread from Needs you"
milestone: RL
size: S
status: done
depends_on: []
branch: task/RL.9-dismiss-thread
lane: services
executor: claude
---

Dom's request, 2 November 2026: a thread in production ("Bruce migration compare") sits in Needs you, and opening it changes nothing. There is no way to settle it or let it go.

`needsYouSources` in `packages/services/src/desk.ts` puts a thread in `answered` whenever its newest post is an agent's. The only way out today is a person posting to it.

## Decisions
- A dismissed thread leaves Needs you until an agent posts to it again. Then it comes back, because that reply is new. Nothing else about the thread changes: it stays in the inbox, and anyone can still post.
- Any member can dismiss any thread, the same as answering (assignment is visibility, not permission).
- The button says `Dismiss`, matching `problem-pane.tsx`.
- No MCP tool, and no event. `attention_cleared_by` records who did it, as it does on runs.

## Scope
- `packages/db/src/schema/inbox.ts`: add nullable `attention_cleared_at` and `attention_cleared_by` to `inbox_threads`, mirroring `runs`. Run `bun run generate` in `packages/db` and commit `migrations/` including `migrations/meta/`. Only this task may touch the schema while it runs.
- `packages/services/src/inbox.ts`: add `clearAttention(principal, { threadId })` with an input schema. It takes a person only, refuses read-only API keys and OAuth clients through `requireWriter`, refuses a run principal, and calls `authorize` through `requireThread`. Dismissing twice moves the time forward. Expose `attentionClearedAt` on `ThreadRecord`.
- `packages/services/src/desk.ts`: `answered` skips a thread whose `attentionClearedAt` is at or after its newest post's `createdAt`. Filtering here also covers `needsYouCount`, the agents overview and the external desk API. Do not go through `rail.clearAttention`: that writes the run row, which `answered` never reads.
- `apps/web/src/server/trpc/inbox-router.ts`: add a thin `clearAttention` mutation on `workspaceProcedure`.
- `apps/web/src/components/desk/needs-you-card.tsx`: `ThreadBody` gets a `Dismiss` button beside `Open thread`, calling `onChanged` once done. Show an error if the call fails, as `problem-pane.tsx` does. `CardActions.onDismiss` takes a run id, so it does not fit a thread card.
- `apps/web/src/components/inbox/thread-panel.tsx`: the same `Dismiss` button on the open thread, shown only while the thread waits (newest post from an agent and not dismissed since). Dom reads the thread here, so this is where the decision gets made. After a dismiss, dispatch `RAIL_REFRESH_EVENT` and refresh the panel. Keep the "does this thread wait" rule in one tested helper.

## Check
- `packages/services/src/desk.test.ts`, beside the existing thread test: a dismissed thread leaves `needsYou` and `needsYouCount`, and comes back when an agent posts later. A person's post after a dismiss keeps it out.
- `packages/services/src/inbox.test.ts`: another workspace's thread gives not found, a run principal and a read-only key are refused.
- `apps/web/src/server/trpc/inbox-router.test.ts`: the mutation needs a workspace session.
- A web test: `ThreadBody` draws `Dismiss` and `Open thread`.
- Browser: an agent reply shows in Needs you on `/desk`, `Dismiss` removes the rail row and moves on to the next item, and the same from `/inbox?thread=<id>`.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from Dom's request.
- 2026-11-02: dispatched.
- 2026-11-02: review clean after 0 fix rounds. Merged and pushed. guest-execution.test.ts hit ECONNRESET once in the merge check under load, and passed on rerun. Migration 0041 still to apply to remote D1.
