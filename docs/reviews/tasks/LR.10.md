# LR.10 review

Peer edits no longer wait on a policy fetch per frame in the document room, and the Artifacts link and export buttons are 40px at 390px.

## Verdicts

Round 0 (reviewer on 8b0bfa1b, sonnet high): clean, no must-fix. The dispatcher applied the cheap nits afterwards: a stale policy response can no longer overwrite a newer one, the stale option comment is fixed, and the no-op deck CSS rule is gone.

## What changed

The document room applies inbound frames from a cached policy and refreshes it in the background (coalesced, plus the 30 s timer). The first sync and any update whose bytes contain `/files/` still wait for a fresh manifest, because the editor reads ownership when it renders an image. Access loss is unchanged: role control, close, error and renewal failure stop the room without a fetch. Tests cover frames applying without awaiting a fetch, blob updates still waiting, and access loss stopping the room.

At 390px the export buttons and the document header link measure 40px (Playwright check on the real CSS). Desktop is unchanged. The deck header link was already 40px.

## Left as is

- The deck room (`live-decks/room-provider.ts`) still fetches the policy per frame. Applying cached frames there made the real-browser deck matrix lose concurrent same-cell typing in 3 of 7 runs (0 of 5 before). Deck peer latency is not fixed. This needs its own task that finds the table-cell race first.
- Every cached frame schedules a refresh, so continuous peer typing causes back-to-back policy fetches. A trailing throttle of 1 to 2 s would cut that.
- `BLOB_MARKERS` is an array for one marker. A plain loop would be simpler.
- The blob test inserts text, not an image node attribute. No test covers a background policy rejection stopping the room.
- The export CSS selector uses the section's aria-label. A class would be sturdier.
- `guest-execution.test.ts` timed out once in the full run (95 s under load) and passed alone.

## Steps for Dom

None. Staging should re-measure peer edit latency for documents after deploy. Decks will still show the old latency.
