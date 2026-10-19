# P.6 review

## Verdicts

Round 1, f988ce6: clean, no must-fix. `bun run check`, `bun run test` and `bun run build` passed in the reviewer's checkout.

## How it works

pi-ai 1.3.0 ignores OpenRouter's `usage.cost`. The OpenRouter provider wrapper in `pi-run-models.ts` now passes each parsed chunk to a probe through `onProviderStreamEvent`, and `withReportedCost` (`openrouter-cost.ts`) sets `usage.cost.total` on the final message when the probe saw a cost. `usageOf` already sums that field into `runs.usage.costUsd`, so a response without `usage.cost` keeps Pi's estimate. Anthropic runs do not go through the wrapper.

## Nits left

- If the source stream throws, the wrapped stream ends without a result, so a caller waiting on `result()` would wait forever. No current pi-ai source does this.
- The "source throws" test does not check `result()`.
- The Anthropic test sets the cost stream, but the fake server always answers `/v1/messages` with the Anthropic stream, so it adds little over the estimate test.
- No test drives the value through `usageOf` into `runs.usage.costUsd`. The link was checked by reading the code.
- Only `cost.total` is replaced. `cost.input`, `output`, `cacheRead` and `cacheWrite` stay as Pi's estimate and no longer add up to the total. Nothing reads them.
- The probe reads top-level `chunk.usage` only, not `choice.usage`.

## Beyond the scope

- On an OpenRouter bring-your-own-key route, `usage.cost` holds only OpenRouter's fee and the provider charge is in `cost_details.upstream_inference_cost`. This matters only if a workspace key uses that setup.

## Steps for Dom

- Staging check (controller): run one GLM-5.3 agent run and compare the stored `costUsd` with the cost on OpenRouter's activity page for that request.
