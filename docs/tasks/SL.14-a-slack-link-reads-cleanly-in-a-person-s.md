---
id: SL.14
title: "A Slack link reads cleanly in a person's post"
milestone: SL
size: S
status: in_progress
depends_on: []
branch: null
lane: slack
executor: claude
---

From the end-of-v4 browser pass (`docs/reviews/v4-browser-pass.md`, SL.8 fail). SL.8 promised that a Slack message with a link reads cleanly in the room. A labelled Slack link in a guest's or member's post shows as raw markdown, `[the launch doc](https://example.com/doc)`. `room-text.ts:122` turns `<url|label>` into markdown, but `room-post.tsx:61-63` renders only agent posts as markdown.

## Scope

- A labelled Slack link in a person's or guest's post shows as readable text with a working link, the way it does in an agent post. Pick the smaller fix: render links in person posts, or have the inbound converter write a form that person posts already render. Don't render other markdown in person posts.
- A bare link and a mention keep working as now.

## Check

- A unit or component test: a person's post with `<https://example.com/doc|the launch doc>` from Slack renders "the launch doc" as a link to that URL, with no brackets.
- `bun run check` and `bunx turbo run test build --only --filter="[origin/main...HEAD]"` pass.

## Log
- 2026-11-21: added by controller from the end-of-v4 browser pass.
- 2026-11-21: dispatched.
