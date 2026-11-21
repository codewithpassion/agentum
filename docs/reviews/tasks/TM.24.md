# TM.24 review

Round 0 (head 167fd2e9): clean. Nothing must-fix. One nit was fixed in f1545159 (the desk start line and the how-it-got-here lines now name the same lead). The browser proof passed at 1280x800 and 390x844, see `docs/reviews/tasks/TM.24/browser.md`.

A proposal is recognised the way TM.12 does it, by the tool name `team_propose_change` plus a parsed proposal (`proposalOf`). The rail card gains an optional `proposedBy` (the lead's name), which drives the Needs you title and the desk item lines. The room heading and the settled line read the proposal from the request display.

## Nits left

- `settledLine` takes a bare `proposal` boolean, and the proposal test `view.kind === "approval" && teamProposalFields(...) !== null` is written twice (`request-card.tsx`, `request-card-logic.ts`).
- `card-view.tsx:171` still reads "Writer Bo, passed on by X" under a desk item title when a proposal's run was passed on.
- The browser verifier saw one server-side SQLITE_BUSY on `inbox.readThread`, at the moment it inserted rows into the local database by hand. It is not from the app.

## Ideas beyond scope

- The Slack settled card (`packages/services/src/slack/request-cards.ts:355`) still says "Allowed once" or "Denied" for a proposal.
- The desk Board view (`needs-you-card.tsx:332`) still headings a proposal "Writer Bo asks for approval".

## Steps for Dom

None.
