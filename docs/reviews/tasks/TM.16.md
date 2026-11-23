# TM.16 review

## Verdict

Round 1 at 9a679a0f: clean, no must-fix.

## Skipped

The browser check at 390x844 is skipped and runs in the end pass. Component tests stand in for it: the composer is one line on a phone until focus, and the topics sheet closes when New topic creates a topic.

## Notes

The sheet already closed on create (the `created` callback in `room-page.tsx`, from TM.23). The new `room-page-sheet.test.tsx` pins it and fails when that line is removed. The test swaps the sheet and dialog for plain stand-ins because Radix portals do not mount when an earlier test file loaded Radix without a DOM.

## Nits left

- `max-md:min-h-10` gives one line only where `field-sizing: content` is supported. Firefox on Android falls back to two rows.
- A collapsed composer shows an empty box with no visible label. A `placeholder="Message"` would help.
- The composer test finds the actions row and hint by markup order.
- No test covers focus moving from the textarea to the Send or dictation button.

## Ideas beyond the scope

The thread composer and the assistant composer also use `StickyComposer` and could collapse the same way.

## Steps for Dom

In the end browser pass at 390x844, check the room: the composer is one line until tapped, the last task chip is visible, and the topics sheet closes after New topic creates a topic.
