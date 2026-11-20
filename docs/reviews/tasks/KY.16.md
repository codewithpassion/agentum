# KY.16 review

Only an agent's owners and admins change its email identity.

## Verdicts

- Round 0, b189dee7: must-fix. The branch started before RH.14 moved `canManageAgentKeys` to `agent-rights.ts`, so the merged tree had a broken import in `room-header.tsx`.
- Round 1, 2f8e370b (merge of main plus the import fix): clean.
- Browser proof, fresh verifier on 2f8e370b: pass, see `docs/reviews/tasks/KY.16/browser.md`.

Checks on the final tree: `bun run check`, `bun run test` (5211 pass, 0 fail) and `bun run build` all pass.

## Nits left

- `room-header.tsx` and `keys/index.tsx` each compute "may manage" from `useAuth` and `canManageAgentKeys`. A shared hook could replace both copies.
- The refused-reserve service test checks `email_local` and the event count, not the `agent_mailboxes` row. No event means the listener never provisions, so the row cannot change. The provision and disable tests do check the row, the triggers and the routing calls.
- The Keys tab shows the "only owners and admins" email note to non-managers even when the mailbox is active, as the Slack note does.
- The Keys tab offers its Email button only when no mailbox row exists, so after a reserve with routing unconfigured (row in `provisioning`) the owner retries from the header ("Try again"). This was already so before KY.16.
- One unexplained `400` console line on the admin's first load after dev sign-in. KY.14's browser report saw the same line, and it does not reproduce.

## Ideas beyond the scope

- `mail.setTrigger` (the mail start toggle on the Jobs tab) still accepts any member. It turns mail runs on or off and does not change the address or mailbox, so it stayed out. Decide whether it should follow the same rule.

## Steps for Dom

None. No deploy, secret or dashboard change is needed.
