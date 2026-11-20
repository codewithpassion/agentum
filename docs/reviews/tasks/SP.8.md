# SP.8 review

Round 0 (f8c245e): clean. No must-fix.

Nits left:
- The mail notice's "Send it again once the agent is resumed." also goes out on the workspace-limit path, where the agent is held, not paused.
- `weekSpend` and `pauseLimitText` in spend-pause-card.tsx have no direct tests; the component tests pass `atLimit` and `limitText` in.
- Resume shows for a moment until the spend query returns.
- An admin whose workspace is held still sees Resume when the agent is also over its own limit (SP.5 behaviour).

Beyond scope: none.

Browser proof: docs/reviews/tasks/SP.8/browser.md, verdict pass at 1280x800 and 390x844.

Steps for Dom: none.
