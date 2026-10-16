---
id: U.1
title: UI polish from the first screenshots
milestone: U
size: S
status: done
depends_on: [F.4, S.2]
branch: task/U.1-ui-polish
---

From the signed-in UI screenshots taken on 16 Oct 2026, approved by Dom. Four problems showed on local main.

## Scope

1. Chat replies show raw markdown (`**bold**`, `- ` lists) in the bubble. Render assistant text as markdown, safely: no raw HTML, links open in a new tab with `rel="noopener noreferrer"`. Use one small renderer for the chat, the session transcript (M9.1) and inbox posts, rather than one per page. User messages stay plain text.
2. The top of the left sidebar is clipped under the header on every signed-in page (the first nav entry sits under the header bar). Fix the shell layout so the whole sidebar is visible below the header at desktop and mobile widths.
3. A session opened from the UI is titled "UI" in the sessions list and transcript. Title it from its first user message (trimmed to about 60 characters), falling back to the agent name and date. Other origins keep a readable title (Slack channel and thread, inbox thread subject, trigger or routine name).
4. Routines show their schedule as raw cron (`* * * * *`). Show a plain description next to it ("every minute", "every day at 09:00 UTC"), with the cron text kept as a tooltip or secondary text. A small formatter for the common patterns is enough; anything else shows the cron text.

## Check

Unit tests: the markdown renderer turns `**a**` into bold and drops a `<script>` tag; the session title uses the first message and the fallback; the cron formatter covers every minute, hourly, daily at a time, weekdays at a time, and falls back to the raw text for anything else. Browser, with dev login on a local dev server: retake the agent chat, sessions list, session transcript and routines screenshots and confirm all four fixes, and check the sidebar at a desktop and a mobile width. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-16: added from the UI screenshots (Dom: yes). Starts after F.4 and S.2.
- 2026-10-16: dispatched on task/U.1-ui-polish.
- 2026-10-16: review clean after 0 fix rounds at 7b5997a (docs/reviews/tasks/U.1.md). Merged. Open nits: non-UI sessions titled from first message, not channel/subject/routine; markdown images load from any URL.
