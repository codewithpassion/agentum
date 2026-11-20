# SP.12 review

Round 1 (9281dd2): must-fix. Session totals were matched by Harbourmaster session, not Anthropic session. The model-pricing table duplicated the dream's price table. The step-failure `failRun` passed no usage.
Round 2 (06ba012): clean. Totals now carry `anthropicSessionId`, the dream prices through `priceTokens`, and the unreachable-failure path reads usage before `abandon`.

## How it works

A managed session reports usage in all, across its turns, and a Harbourmaster session reuses one Anthropic session for many runs. A run's usage is the session's totals now minus the totals the session's previous run stored in `runs.usage.sessionTotals`. Cost is the session's `list_cost` when known, otherwise tokens priced from `packages/services/src/model-pricing.ts`.

The Anthropic API does report usage (`session.usage`), so the "no usage at all" case did not apply and the Settings cap note was not added. A session that reports none records no usage, as before.

## Nits left

- A reused session's first run after deploy has no stored totals, so it is charged the session's whole lifetime use once.
- 1h cache writes are priced at the 5m factor (1.25x, not 2x). No long-context tier.
- A cancelled run records no usage. Its spend lands in the next run's difference on the same Anthropic session, but is lost if that session was closed.
- The fake gateway's `getUsage` ignores closed sessions, so the abandon-order test does not prove the order.
- `sessionTotals` is stored inside `runs.usage` and shows wherever usage is read.
- `priceTokens(...) ?? 0` in the dream hides a model with no rates. No test pins the haiku rates directly.

## Ideas beyond scope

Cost for cancelled runs. A real long-context price tier. Move `sessionTotals` out of the user-visible usage.

## Dom

Check the opus ($5 in, $25 out) and sonnet ($3 in, $15 out) rates in `packages/services/src/model-pricing.ts`. They are unverified estimates used only when the API gives no cost. Haiku's rates are the dream's checked ones.
