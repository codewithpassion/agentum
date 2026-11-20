# SP.9 review

Round 1 (d54acb1): clean, no must-fix.

Nits fixed: stale help text in settings.spend.tsx and a stale comment in desk.ts, both said a pause waits for a manual resume.

Nits left:
- The tick lifts any `spend_cap` pause once the agent and workspace are under their caps, so raising a cap mid-week also lifts it within a minute. This follows the task's "under their caps" wording.
- `liftCapPauses` checks every cap-paused agent in parallel with no batching. A workspace-cap pause rescans that workspace's week once per agent per minute until the week rolls over.
- No test covers a pause set by the workspace cap rolling over.

Steps for Dom: none.
