# SL.14 review

Fix: `room-post.tsx` renders `[label](http(s)://url)` as a link in person and guest posts. No other markdown is rendered there. The inbound converter is unchanged.

## Verdicts

Round 1 at 9455839: clean, 0 fix rounds.

## Nits left

- The component test starts from the markdown text, not from Slack's `<url|label>`. The converter has its own test in `packages/services/src/slack/room-text.test.ts`, but nothing tests both steps together.
- A URL containing `)` ends the link early. Agent posts render it correctly.
- A label containing `]` stays as raw markdown.
- Labelled links with schemes other than http(s) (`tel:`, `slack://`) stay as raw markdown. Kept on purpose, since it avoids `javascript:` links.

## Ideas beyond scope

- Share one link parser between the converter and the post renderer so the two can't drift.

## Skipped browser steps

None in the task's check. The controller's end-of-v4 browser pass re-checks SL.8 in the room.

## Steps for Dom

None.
