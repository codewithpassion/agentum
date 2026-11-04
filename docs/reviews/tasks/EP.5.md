# EP.5 review

Opened from the EP staging check on 5 Nov 2026. Implemented by Codex (gpt-6.1-sol), reviewed by Claude Opus.

## Found on staging
- A person's MCP update became current before its grants were recorded, so approvals were never carried and every update took the endpoint offline until re-approval.
- Publishing a version with a pending agent grant paused the app trigger, and nothing could resume an app trigger, so `/ask` failed for good with "app trigger is unavailable".
- A throwing app gave a fixed 502 and no trace anywhere.

## Round 1 (ef0102f0 + f5829dae): must-fix
- A rejected version still told the MCP person to approve in Needs you.
- The `waiting` text gave runs the person's instructions and claimed a live version where there was none.

## Round 2 (3147d6ac): must-fix
- The `artifact_update` reply still claimed a live version for a never-promoted app.
- The Needs you filter let a run's newer proposal (no card) hide the person's card.
- Promoting a replaced version still pointed to Needs you.

## Round 3 (460b77b0): clean, reviewed by the controller. A third fix round was allowed by the controller: the findings were narrow wording and one filter.

## Left
- `app.error` reads scan events by `json_extract` without an index; bounded by the rate limit, but it grows.
- `errorSlot(restoreDropped)` does two jobs in one RPC.
- Runs whose agent may update an artifact can read its app errors, slightly wider than "can manage".
