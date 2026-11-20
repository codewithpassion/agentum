# RH.9 review: one time zone rule for what the app prints

## Verdicts

- Round 1 (b37bb3d7): clean, no must-fix. The reviewer also ran the web tests under `TZ=Pacific/Kiritimati`; they pass.
- Fix rounds: none. After the review I deleted the unused `scheduledTime` formatter (1d86dbc0), a nit about code my own change left orphaned.
- Browser proof (`docs/reviews/tasks/RH.9/browser.md`, 0b1c9ad1): pass at 1280x800 and 390x844, in Australia/Sydney against a UTC server. Chat, task page, run picker, log rows, files list, desk pane and roster card all printed the Sydney hour. No console errors, no hydration warnings.

## The rule

A thing that happened prints in the viewer's browser zone through `lib/time.ts` and `hooks/use-viewer.ts`. The hook gives the server and the first browser paint UTC/en-US, then the browser's own zone and locale, so hydration matches. A schedule (a card's "Next run") prints in the workspace zone with the zone named, from the roster service. The roster card carries `doneAt`, and the browser prints "Done <time>" from it.

## Nits left

- `roster-logic.ts` puts the finish time back by matching the `"Done: "` prefix (`DONE_STATUS_PREFIX` in `@repo/db/shared`). Separate title and next-run fields on the card would be sturdier.
- `fileTime` in `files-logic.ts` now only calls `clockTime`.
- `Next run` stays `en-AU` on the server, so the viewer can see "pm" on the schedule beside "PM" on the clock part, and the headless browser (en-US) reads "Nov 21" where the server writes "21 Nov".
- No render test for a Done card with `doneAt` set; `cardStatusLine` is tested.
- A run with an empty title prints "Done 8:13 pm: " (as before).

## Beyond scope

Other places still print their own way: `desk.tsx` and `task/receipt.tsx` use the browser zone during render (not hydration safe), `toLocaleString` in the mail list and thread, artifact and live-artifact history, guests and the enroll dialog, and UTC prints in `sessions-logic.ts`, `library-logic.ts` and `log-table.tsx` (the last two say "UTC"). A follow-up could move them to `lib/time.ts`.

Browser proof side notes: flow F (a settled question's "at <time>") was not exercised, because the fake runtime only echoes. `taskSettlement` has unit tests in Sydney and UTC. Clicking "Draft job" in the Jobs tab returned a 400 (no Anthropic API key in the local workspace); it is outside this task.

## Steps for Dom

None. After deploy, on staging, open a chat in a non-UTC browser and compare the message time, the desk pane's "How it got here" and the card's "Done" time.
