# SL.8 review: Slack markup both ways

## Verdicts

- Round 1 (be4dbb39): not clean. One must-fix: inbound `readSlackMarkup` did not decode `&amp;`, `&lt;`, `&gt;` inside link and mention tokens.
- Round 2 (4a77f437, fix commit only): clean.

## What changed

- In: `readSlackMarkup` (room-text.ts) turns `<@U>`, `<#C>`, `<!here>`, `<url|label>` and entities into readable text. `room.ts` looks up user and channel names best effort.
- Out: `toSlackMrkdwn` (room-out-text.ts) turns markdown into mrkdwn and escapes `&`, `<`, `>`. `room-out.ts` then turns an `@name` that is one linked person into a Slack mention.
- The Slack client's `postMessage` has a `mrkdwn` flag that skips its own escaping, used only by the room send, which escapes first.

## Nits left

- Markdown links become Slack masked links, so a post can show one URL and open another (`[bank.com](evil.com)`). Decide whether that is acceptable for agent text.
- `convertMentions` also runs inside link labels, URLs and code spans (`[hi @ada](url)` nests markup).
- `__x__` and `~~x~~` run over URLs; `# **Title**` and `***x***` do not render as bold.
- A room post can no longer carry a raw `<@U...>`; it shows as text. Agents use `@name` instead.
- Inbound mentions read as `@Display Name`, which may not convert back to a mention on the way out.
- `withMentions` repeats the linked-people lookup on each fallback app.
- `<foo&amp;bar>` (a token with no scheme) is left undecoded.
- No test for a markdown link whose URL holds `|`.

## Ideas beyond scope

- Read mrkdwn bold and italics (`*x*`, `_x_`) inbound as markdown.
- Skip `@name` conversion inside code spans and link text.

## Steps for Dom

- Skipped the task's browser step (message with a mention and a link in the room, and `@ada` in a person's post going out as a real mention). Check both in the end-of-v4 browser pass.
