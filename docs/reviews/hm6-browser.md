# HM.6 browser pass: one working indicator with a queued reply

Run on branch `task/HM6-browser` from main at 0f87b2ab. Local dev server on port 3421, headless Chrome through agent-browser (session hm6), dev login. Sizes 1440x900 and 390x844. Screenshots are in `docs/reviews/hm6-browser/`. No product code was changed.

Setup: enrolled `scripts/dev/fake-daemon.ts` as a machine, created a blank agent "Machine echo" that runs on it, and used the conversation on the Chat tab. The daemon first ran without `--echo`, so the run is offered but never claimed and the task stays working. Spinners were counted from the DOM: visible elements matching `[data-slot="spinner"], .animate-spin` (the `Spinner` component renders an svg with that attribute).

| Step | Desktop | Phone |
| --- | --- | --- |
| 1. One spinner, none in the strip above the reply box | pass | pass |
| 2. Waiting message with Remove and no spinner, one spinner, Right now names the working task | pass | pass |
| 3. Tool card spins and "Working" hides | not run | not run |
| 4. End the step, the waiting message runs next | pass | pass |

## 1. One spinner while working

Desktop: after the first message the page has 1 spinner, the "Working" line under the turn. The strip above the reply box ("The agent gets this when the current step ends.") has none. Right now shows the first message. (`step1-desktop-working.png`)
Phone: same, 1 spinner, no horizontal scroll (scrollWidth 390). (`step1-phone-working.png`)

## 2. Second message while working

Desktop: the second message shows "Waiting for the current step to end" with a Remove button and no spinner. Spinner count stays 1, still the "Working" line of the first turn. Right now still names the first message ("From UI: first message"), not the waiting one. (`step2-desktop-queued.png`)
Phone: same result: 1 spinner, one Remove, Right now names "phone first", not "phone second". (`step2-phone-queued.png`, `step2-phone-rightnow.png`)

## 3. Tool call

Not run. The fake daemon has no tool step (no tool frames in `scripts/dev/fake-daemon.ts`; it only claims and completes with an echo). The tool-card rule (only the latest tool call spins, "Working" hides while it does) is covered only by the component tests, not by this pass.

## 4. End the step

Desktop: restarted the daemon with `--echo`. Task 1 completed, then the waiting message ran as task 2 with its echo. Afterwards 0 spinners, no Remove, Right now says "Nothing is running". (`step4-desktop-done.png`)
Phone: same with "phone first" then "phone second" (tasks 3 and 4, in order). 0 spinners after. (`step4-phone-done.png`)

## Console and requests

No console errors, only the Vite debug lines, the React DevTools hint and the Clerk development-keys warning. `agent-browser errors` was empty. The dev server log has no errors. I could not get a failed-request list: the network capture returned nothing in this session, so failed requests are unchecked beyond that.

The fake daemon logged `claim ... failed: 409` for the last run each time it ran with `--echo`, after the run had already completed. That is the daemon's duplicate claim on a re-sent offer, not a page problem.

## Notes

- Typing duplicated one message ("second message queuedsecond message queued") in the desktop pass. That was my retry typing into a box that already held the text, not a bug.
- No must-fix bug found.
