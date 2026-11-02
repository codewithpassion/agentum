# RL.9 review

Round 1 at 9711ec4: clean, no must-fix. Check, test and build pass, the bundle grep for `drizzle` finds nothing, and the browser check passed on a local dev server: an agent reply showed in Needs you, `Dismiss` on `/desk` removed the rail row and opened the next item, a new agent reply brought the thread back, and `Dismiss` on `/inbox?thread=<id>` removed it again.

## Nits left

- `threadWaits` (`inbox-logic.ts`) ignores draft agents, but `desk.ts` drops a draft agent's post from Needs you. A thread whose last post is a draft agent's shows `Dismiss` in the open thread while it is not in Needs you. Harmless, since the dismissal only stamps a time.
- The dismissal is stamped with the server's time, not the newest post the person saw. An agent reply that lands between the last poll and the click is hidden too. Sending the newest post's `createdAt` with the call would close it.
- `clearAttention` refuses with the `inbox.post` action name, so a refusal reads as a post.
- The comment above the `dismissed` check in `desk.ts` says "a post newer than it", which also covers a person's post. Only an agent's post brings the thread back.
- `0041_cool_bloodaxe.sql` has no final newline, as drizzle-kit writes it.

## Beyond scope

- `listThreads` returns the newest 50 threads, so an old waiting thread past that limit never reaches Needs you. This predates the task.

## For Dom

- Migration `0041` has to be applied to the remote D1 (`wrangler d1 migrations apply DB --remote`) before the deploy, or the thread list fails on the new columns.
