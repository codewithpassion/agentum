# ME.12 review

Round 1 at d78cd42f: clean, no must-fix. Check, test and build pass. Fix commit 4ed0ce23 took the long-string wrap nit and added the whitespace-only test. Browser proof (fresh verifier, desktop and phone, no console errors or failed requests): pass, see `ME.12/browser.md`.

## Nits left

- `rowDetail` cuts by UTF-16 units, so it can split an emoji at the clip point. The server's `clip` in `desk.ts` does the same.
- A note long enough to wrap leaves the agent tile alone on the first line, with the text on the lines below, because the row is a flex-wrap line.

## Beyond scope

- The roster's `statusLine` and the item page's "Now: ..." line still use the heading as the card's status. That is right for them, so the change lives in the drawer row and not in the service's `status` field.

## For Dom

- Nothing.
