# L.6a — thread actors and author presentation

Implemented 2026-10-27 on `t3/2b3bcf6c`, bounded to protocol thread folding and thread author presentation. Read `CLAUDE.md`, the L.6a brief and live-artifacts PRD section 8 / R1.35. Parent L.6 remains incomplete.

## Behavior

`ThreadEvent.actor` preserves the existing event schema's `{ id, kind }` authenticated identity. `foldThread` now forwards it instead of replacing every stored actor with a synthetic agent; `applyFrame` copies it onto each user message. Legacy structural events without actors remain unattributed. Names and actor IDs are never extracted from message payloads, speaker envelopes, attachments or assistant deltas. Multipart and truncated user messages retain attribution at the message level. Replayed event IDs remain no-ops.

Optional `ThreadActorDisplay` / `actorDisplay: { name: string }` is an adapter-only, browser-safe extension in `thread.ts`; existing event/stream wire schemas are unchanged. The fold copies only the display name, discarding additional profile fields. Identity remains the event actor, never the display name.

The UI infers multiple people from distinct `(kind, id)` user/guest actors, or accepts trusted `multiPerson` session data through `useTaskThreadRuntime`. A single-person session keeps its existing presentation. Multi-person messages show names with per-person ordinals, distinguishing duplicate names and providing safe `Person` / `Guest` fallbacks when display data is absent. Unknown legacy authors are labeled unknown rather than guessed. React escapes names. Assistant-ui custom metadata carries only the resulting label and existing run ID.

## Exact remaining L.6 service / transport wiring

1. Keep the authenticated `actor` from the existing events adapter (`packages/services/src/events.ts` maps stored actor columns already) on session history and SSE events. Do not derive it from submitted text or a client's author field. Missing actors cannot be recovered by this UI.
2. Enrich history with optional top-level `actorDisplay: { name }`, resolved using the event actor. For members use the existing people lookup's `name` (the Clerk first/last-name presentation in `apps/web/src/server/clerk-people.ts`). For guests use the verified guest record's existing `displayName` (`packages/db/src/schema/live-artifacts.ts`). Do not substitute private email addresses when no display name exists; omit the display extension and allow the safe UI fallback. Do not send whole profile or grant records.
3. For live delivery, either enrich parsed frames in the trusted client/session adapter as `ThreadFrame`, or add the same optional top-level display object to the stream event schema and its server producer together in the service integration lane. The current strict `eventFrameSchema` does not accept this extension on the wire. History and live adapters must use the same resolution so reload/reconnect names agree. `actorDisplay` in the payload is intentionally ignored.
4. Pass trusted room/session presence information as `multiPerson: true` to `useTaskThreadRuntime` when more than one person is present, including before another participant sends a message. Without it, labels start when a second distinct authenticated person appears in history. The existing task callers need no changes for single-person web chat.
5. Speaker-envelope construction, Slack linking/names, guest run authorization and agent instructions remain in parent L.6. No service, session, run, MCP, prompt, database or schema implementation was changed here.

## Verification

- Focused protocol thread suite: 27 passed, 0 failed. Actor tests cover two speakers, a forged envelope/payload actor, files, truncated user content, streaming assistant deltas, persisted replay equivalence, immutable prior user objects, replay deduplication and legacy unknown actors.
- Focused UI author / conversion suites: 15 passed, 0 failed. Covers duplicate names, missing names, user/guest identity separation, single-person behavior, presence override, attachment preservation, label propagation and escaped rendered attribution.
- Root test: passed (9 package tasks and 284 root script tests; web has 3253 passed and 1 existing skip). Root build: passed (2 tasks). Root check: passed (lint, 9 typecheck tasks and clean boundary lint).
- Browser boundary scan: `rg -l 'drizzle|cloudflare:workers|#/server/' apps/web/dist/client` returned no matches after the final build. `git diff --check` passed.
- Setup: installed worktree dependencies with `bun install --frozen-lockfile` after initial commands found missing local tools. An intermediate check overlapped Vite's output replacement and reported missing generated `dist/server` files; reran root check after build completed. A subsequent check exposed missing generated Env secret types; copied `.env.example` to ignored `.env` as documented in CLAUDE.md CI setup, then reran check. Build reports the existing CSS sourcemap warning.
