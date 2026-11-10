# TH.3 review: one conversation list, and a main thread per agent

## Verdicts

- Round 0 (dcce758d): the reviewer marked one must-fix, that every thread link goes to `/threads/<id>`, which TH.2 builds in parallel. The brief says to link anyway and note it, so no code changed. TH.3 must merge after TH.2, or thread links 404 until it lands. Everything else was a nit.

## What changed

- Shared `ConversationList` (`components/conversations/`), used by the assistant panel and the history page. Rows show a time. Rows with an `href` are links, others are buttons. The history page marks each row Thread or Assistant.
- `/sessions` is now the history page, titled Conversations. It lists threads and assistant conversations by last activity, with search, agent, origin and "Running now" filters, and "Show more" paging.
- New service `conversations` (`packages/services/src/conversations.ts`) and tRPC `conversations.list`. It merges the sessions list and the assistant list on one (activity time, id) cursor.
- `sessions.list` takes `query` (stored name or any run input) and `working`.
- `assistant.list` takes `cursor`, `limit` and `query`, capped at 50, each item carries a `cursor`. `assistant.get` returns the newest 50 messages, `before` pages back, and the reply carries `hasEarlier`. The panel has Show more and Show earlier messages.
- Find opens your main thread when you pick an agent. The agent page has a Conversations card with Open main thread, New conversation and All conversations. All tasks and View all N running link to `/sessions` with the filter set.
- `NewTaskDialog.onStarted` now also passes the session id.
- Removed `components/sessions/session-list.tsx`, which the new page replaced.

## Nits left

- Show earlier messages triggers the scroll to bottom effect.
- A finished turn resets the loaded list pages and messages to the newest page.
- The client repeats the page size 50 instead of sharing it.
- The working filter writes the run statuses inline, not from `LIVE_RUN_STATUS_LITERALS`.
- `activity-cursor.ts` and `likeEscape` in `packages/db/src/assistant.ts` copy helpers from `sessions.ts`.
- The search box keeps its text when `?q=` changes by back and forward.
- "View all N running" counts runs the rail sees, the list hides other members' UI threads.
- Assistant conversations match on title only.

## Ideas beyond the scope

- Pin the main thread to the top of the agent card.

## Could not verify

- Staging check (two clicks from the rail) is the controller's, and needs TH.2.
- No browser check against a local dev server.
- `bun run test`: `guest-execution.test.ts` fails as on main (miniflare). The hooks timing test and one slow services test failed once under load and pass alone.

## Steps for Dom

None.
