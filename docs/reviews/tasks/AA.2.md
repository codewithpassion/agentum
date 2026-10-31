# AA.2 review

## Verdicts

- Round 1 (397a87f): not clean, six must-fix. The joiner did not check the inviter's card was on the host it called, the OAuth token URL was not vetted, a card refresh could undo a revoke, `activate` was not idempotent, `peerRevoked` missed a joiner still waiting, and a failing revoke notice skipped the event and the hook. All fixed.
- Round 2 (9575954, fix commit only): not clean, three must-fix. `decline` had the same unguarded notice, approving a refreshed OAuth card skipped the token URL check, and a card that moved twice while pending was not logged. All fixed.
- Round 3 (445f7b1, fix commit only): not clean, two must-fix. A moved OAuth token URL was not shown to the approver and approve sealed the client secret to it, and `approve` acted on whatever card was stored at that moment.
- Controller decision after round 3 (over the two-round limit): fix both, plus the refresh status guard, and run one more round. A credential must never go to a destination a person did not see and approve. The approved destination is the interface origin plus the OAuth token URL. A refreshed card that changes either returns the connection to `needs_approval` with the pending value kept apart, the summary and events show current and pending origin and token URL, and the client secret is not sealed to a pending token URL until approval. `approve(principal, id, { origin, tokenUrl })` takes what the caller saw and refuses with `conflict` on a mismatch.
- Round 4 (4e65cc4, fix commit only): not clean, one must-fix. Two overlapping refreshes (the tick and a person) can log `a2a.connection_reapproval_needed` with a destination the stored card does not hold, because `flipped` in `refreshCard` assumes this call's write landed. No credential goes to an unapproved destination.
- Controller decision after round 4: fix it, log only when this call's own update changed a row, add a test with two overlapping refreshes, and review that commit alone.
- Round 5 (99f4f05, fix commit only): clean. The write is one UPDATE ... RETURNING on the status read, and the event logs only when it landed. The new test fails on the old code (two events instead of one).

## Nits left

- Round 5: the `refreshCard` write matches on status only. Two refreshes that both read `needs_approval` can log the same card twice, or log B and then write A back without logging. A flip and an approval inside one slow fetch let a stale write put an approved connection back to `needs_approval`, which only narrows access. Also matching `peerCard` in the WHERE, as `approveNewOrigin` does, fixes all three. The comment above the write overstates this, and the test title only covers the race from `active`. If `events.append` throws after the update, the row is `needs_approval` with no event.

- Round 4: no committed test covers the `peerCard` compare-and-set in `approveNewOrigin`.
- Flip, approve, back to `active` in the gap of a stale fetch can leave an old card in `peerCard` while `outboundScheme` and the credential say the new one. AA.5 must read the send URL with `peerOrigin`, not from `peerCard` alone.
- A change of API key header name is now approved on the same kind, with identical current and pending values shown. The scheme label should carry the header name into the comparison, as it carries the token URL.
- A scope-only change is not a change: it does not flip an active connection, logs nothing while pending, and the sealed scopes stay stale or widen without being shown.
- `tokenUrl` in `approveSeenSchema` is capped at 2000 characters while the card schema has no cap, so a longer URL cannot be approved and raises a `ZodError`.
- `readOauthCredential` hides a missing `secretsKey`, so the person is told to re-add the agent.
- `a2a.connection_created` has no `tokenUrl`, so the first approved URL is not in the log.
- The "destination changed" message also fires when a revoke or decline wins the race.
- The `row.peerCard === null` branch in `approveNewOrigin` cannot run. Two comments still describe origin moves only.
- From earlier rounds: multi-statement writes outside `atomic` in `endConnection`, `markActive`, `decline` and `failInvite` (AA.5 must deliver a `pair_activate` row only while its connection is `activating`), no unique index behind the duplicate check, a duplicate check that compares exact strings, `decline` and `unpublish` open to any session member, the inviter's `join` trusting the card URL it is given (activation fails if it is false, so the risk is social), `a2a.*` events with no text key for `/log` summaries, and `connections.ts` at about 2,100 lines.

## Ideas beyond the scope

- `docs/v3/agent-connections.md` still says "origin" where it now means origin plus token URL, and AA.7's pending-connection card should list the token URL and send the seen destination back to `approve`.
- A tRPC error mapping for `ZodError` as `invalid` in the router init, which bears on the cap nit.
- A unique index on (`local_agent_id`, `peer_card_url`) for live rows.

## Steps for Dom

None.
