# A.7 review

Round 1 (f0ec4ac): must-fix. The "card before an open delta" test never exercised the two cursor shifts, so deleting them left every test green. Fixed in d839657 with two real cases (card after a tool call before an open delta, and a late tool call) and a mutation check.

Round 2 (d839657): clean.

## Nits left
- A card for a new version that arrives before its own tool call pulls that call back to the card's slot, ahead of earlier text. Only happens with out-of-order events.
- Runless `artifact.published` events (`runId` null) each become their own message with no dedupe. Confirm with A.2 which events reach the session stream with a null run.
- No test pins the empty-string `toolCallId` fallback to null.
- The reload-mid-run test replays one stored event and does not send a live `tool.call` before the new version.

## Beyond scope
- `apps/web/src/components/thread/thread-parts.ts` got a 3-line `artifact` to `data-artifact` branch so typecheck passes. A.13 owns the real mapping and will conflict on that spot, keep A.13's side.

## Steps for Dom
None.
