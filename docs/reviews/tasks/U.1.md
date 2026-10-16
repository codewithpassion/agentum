# U.1 review

## Verdicts

Round 0, commit 5c3b19a (the task commit e762a1a plus a merge of main): clean. No fix rounds.

## Checks

`bun run check && bun run test && bun run build` pass, and the client bundle has no `drizzle`. Live, on a local dev server with dev login and the compiled daemon on a separate HOME, a real `haiku` reply with bold text and a bulleted list renders as markdown in the agent chat and in the session transcript. The transcript heading is the first message and the list shows the same. The sidebar shows its whole content under the header at 1440 and 800 px and in the mobile sheet at 390 px. Routines show "weekdays at 09:00 UTC" and "every day at 09:00 UTC" with the cron text under it. Screenshots are in the controller's `scratchpad/screens-after/`.

## Decisions

- One renderer, `components/markdown/markdown.tsx`, built on `react-markdown` (new dependency). Raw HTML is dropped, link URLs go through the library's sanitiser, links open in a new tab with `rel="noopener noreferrer"`. It renders assistant text in the chat and the session transcript, and agent-written inbox posts. User messages and user posts stay plain text.
- The sidebar was a fixed full-height panel under the sticky site header. The header is now `--app-header-h` tall from `md` up (`styles.css`), and the sidebar starts below it. Below `md` the sidebar is a sheet and was not clipped.
- The service title is the first message trimmed to 60 characters (was 80), and the transcript now carries it too. The transcript heading uses it, with the origin label below. An empty title falls back to "agent name, date time".
- `describeCron` covers exactly what `compilePreset` produces. A test fails if a preset stops being described.

## Nits left

- The fallback title formats the time in local time with no zone. In the sessions list the route loader renders on the server, so a session with no runs could show a hydration text mismatch.
- Slack, inbox, trigger and routine sessions keep the first message as title. The task names a Slack channel and thread, an inbox subject and a trigger or routine name; nothing origin-specific was added.
- Single newlines in agent replies now merge into one paragraph. `remark-breaks` would restore the old line breaks.
- Agent markdown images render as `<img>` for any URL. Dropping `img` in the `components` map would stop tracking pixels and layout blowout.
- The header is a fixed height from `md`, so a much wider user block could overflow. It does not today.
- Bare URLs are not auto-linked (no GFM).

## Ideas beyond the scope

- Add `remark-gfm` for tables and autolinks if agents start sending them.
- Name sessions by origin (Slack channel, inbox subject, trigger or routine name) by joining those rows in the sessions service.

## Steps for Dom

None.
