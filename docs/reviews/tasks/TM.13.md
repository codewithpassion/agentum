# TM.13 review

Verdict: clean in round 1 (commit 52673a9a), no fix rounds. Browser proof: pass at 1280x800 and 390x844, see `docs/reviews/tasks/TM.13/browser.md`.

"Can see the topic" means "is in the topic". Reading a team's room stays open to the whole workspace, as the controller decided.

## Nits left

- `packages/services/src/inbox.ts` `readThread`: the `limitedTo` query has no `orderBy`, and it re-reads rows that `canReadTopic` just read.
- `room-thread.tsx`: the composer's mention list (`mentionable`) still offers team members outside a limited topic.
- MCP `inboxRead` (`apps/web/src/server/mcp/ports.ts`) does not pass `limitedTo` on.

## Ideas beyond the scope

- Limit the mention suggestions to the topic's members.
- Show an agent in a limited topic who else is in it.

## Steps for Dom

None.
