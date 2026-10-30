# The rail: test results

Tested on staging on 31 October 2026. The video is `media/rail/harbourmaster-rail.mp4` (2:16, silent, with captions), and it comes from the same runs, on Worker version `2fd2084c`. Staging now runs `ff0201d1`, which adds RL.8's two fixes. Neither fix changes anything shown in the video. I smoke-tested that version in a browser: rows open with no false notice, Mine and Everyone switch, and no "quoted JSON" shows on Sessions. Raw results are in `media/rail/acceptance.json`, screenshots in `media/rail/screens/`, and the script is `tooling/rail-video.ts`.

## What was tested

Two reviews of the whole milestone ran as well, `docs/reviews/RL-1.md` and `RL-2.md`, plus a review per task. Three people, on real staging data, through a real browser: Nina in a new workspace, and Priya and Dan at Northbank Advisory with two agents. Mail came from the simulator workspace through Cloudflare Email Routing. Replies went to reserved `.example` addresses, so nobody received anything, and they bounced, which tested the stuck-work path for real.

All 30 checks passed.

| Spec "Done means" | Checks | Result |
|---|---|---|
| Priya sees only her items on Mine, Dan sees his | Mine hides Dan's work. Dan's Mine holds his agent's work. Dan doesn't see the Kestrel replies. Everyone names who an item is for. | Pass |
| An approval older than 4 hours appears for the backup | Dan saw "asked you too" on Priya's item | Pass, with the item's age changed by hand in staging D1 |
| Mail tasks read as their subject everywhere | No "quoted JSON" in the rail or on the Board | Pass in the browser. The Task page and Sessions are covered by service tests in RL.6. |
| A new mail doesn't move what Priya reads | A new row arrived, and the open row and pane stayed put | Pass |
| A failed run appears until dismissed | A bounced mail appears, names the address, and Dismiss clears it | Pass for a bounce. A failed run is covered by service tests only, because I didn't force one on staging. |
| A new workspace sees the two setup steps | Both show, each leaves when done, the error links to Settings, and the description survives | Pass |
| Every page reachable through Find | Spot check in the browser, and `find-registry.test.ts` compares the list with the route files | Pass |
| `check`, `test`, `build`, bundle grep | Run by the controller on every merge | Pass |

Also checked: grouping (two Kestrel mails became one row with `+1 more`, and both replies opened), due sorting on a fresh load (`Due today`, then `Due tomorrow`), plain reply text, hand-off labels, and a phone at 390x844 (inline list, no sideways scroll).

## What this run found, now fixed

- Reply titles showed raw addresses, and `They wrote` was empty when an agent's reply started a new thread (RL.7).
- The first gate found that a person's private run on a colleague's agent reached nobody's Mine, that mail tasks still had the old title on the Task page and Sessions, and that the pane dropped proposal and thread detail (RL.6).
- The second gate found that clicking a brand-new row could briefly claim the item was gone, and that thread history rows all showed the same name (RL.8).

## Limits worth knowing

- **Due dates are a text heuristic.** It reads phrases such as `by 9am tomorrow`. Anything it misses keeps its age order.
- **The open row holds its place,** by design. An item that's open when something more urgent arrives stays where it is until the page reloads or the person moves on, so the most urgent item isn't always on top.
- **Done doesn't mean it went well.** An agent that finishes by saying "I can't verify this" still counts as done, and its work stays out of Needs you. In an earlier run, Invoice Chaser did exactly that until I told it to write the reminder anyway. Only failed, interrupted and bounced work comes to a person.
- **The model decides whether a reply is held.** The rail shows approvals, so an agent that writes a reply in its summary instead of using the mail tool creates nothing to approve. The brief has to say to use the mail tool.
- **The Task page still shows the raw prompt.** Its title reads as the subject, but the Thread panel shows the exact text the agent received, starting "Inbound mail. The quoted JSON below...". That's the page's raw view, and tidying it was out of scope.
- **Reply text can't be edited before sending.** `Tell it what to change` denies it with a note instead.
- **Staging crons are off,** so expiry of a waiting run wasn't tested by time passing.
