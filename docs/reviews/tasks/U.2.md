# U.2 review

## Verdicts

Round 0, commit 0e45d47: clean. No fix rounds.

## Checks

`bun run check && bun run test && bun run build` pass, and the client bundle has no `drizzle`. Live, on a local dev server with dev login: a trigger fired with curl and a routine fired through `/cdn-cgi/handler/scheduled` show in the sessions list as "Deploy hook" and "Morning digest". Renderer tests cover an external image becoming a link, a `/files/<id>` image staying an `<img>`, a library download image, a protocol-relative URL and a `/files/<id>/../x` path. Title tests cover trigger, routine, inbox, Slack, and each fallback.

## Decisions

- Markdown images match only root-relative paths: `/files/<id>` and `/api/library/download?...`. Absolute URLs never match, even to this host, because the host is unknown during SSR and a client-only match would mismatch on hydration. A blocked image becomes a link whose text is the URL.
- Trigger and routine titles key on the session's `actorKind === "trigger"` and join `triggers.name`. Routines start their sessions with origin `"trigger"` (`routines.ts`), so keying on origin `"routine"` would miss them. The origin enum still lists `"routine"`, and `apps/web/e2e` seeds sessions with it. Left as is.
- Inbox sessions join `inbox_threads.title` on the session's external key.
- Slack stores no channel or user names, and a Slack call before the 200 would break the "nothing slow before the answer" rule. So the after-answer job calls `conversations.info` (channel) or `users.info` (DM) and appends a `slack.named` event `{label}` to the session. The sessions service reads the newest one. The title is `<label>: <first message>`. No new table, no migration, since `events.type` has no CHECK constraint.
- The manifest gains `channels:read` and `groups:read` for the channel lookup.

## Nits left

- `nameSession` runs for every message, so each reply in a Slack thread repeats the lookup and appends another `slack.named` event. It could skip a session that already has a label.
- `labelOf` in `sessions.ts` calls `JSON.parse` without a guard. A malformed `slack.named` payload would break the list. Only `events.append` writes them.
- The three title reads filter by id only, not by workspace, like the existing `runs` read in `withRuns`.
- A blocked image shows its URL, not its alt text.
- The Slack label is a snapshot from the first message. A renamed or deleted channel keeps its old name, so the "source name is gone" fallback never applies to Slack.
- `docs/architecture/index.html` "Event types in v1" misses `slack.named` (it already misses `slack.app_installed`).

## Ideas beyond the scope

- Skip the Slack lookup when the session already has a label.
- Align the `"routine"` session origin with what routines write, or drop it from the enum.

## Steps for Dom

Existing Slack apps need a reinstall with the new `channels:read` and `groups:read` scopes (regenerate the manifest, update the app, reinstall to the workspace). Until then channel sessions keep the first message as their title. DM titles need no new scope.
