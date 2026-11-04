# EP.6 review

Executor: Codex (gpt-6.1-sol). Reviewer: controller (Claude Opus).

- `triggers.fire` passes `offerLater` only when an app fires it and the composition has `defer`. A token-fired trigger still offers inline.
- The offer runs through `defer` (`waitUntil`) with the system principal. A failure is logged, and the minute sweep offers any run that nobody offered.
- `compose.ts` passes `infra.defer` to the triggers service. `exports.test.ts` checks that the AppHost wiring imports `waitUntil` and passes it to `compose`.
- `trigger.fired`, `lastFiredAt` and the `waitForRun(0)` read stay before the answer. Each is one D1 round trip, which is small next to the offer.
- Tests: four new triggers tests (deferred offer, inline offer without `defer`, token fire unchanged, sweep after a failed offer). `bun scripts/e2e/app-bot.ts` PASS with the reply delivered. The full check, test and build pass on main.
- Verdict: accept.
