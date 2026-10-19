# P.1 review

Round 1 at ac7c36b: must-fix. A validator throw (OpenRouter 5xx or 429) was reported as "OpenRouter did not accept that key", which tells the user their key is bad during an outage. Fixed in b82dc73: a check that cannot run is its own refusal, "Could not check that key with OpenRouter. Try again later.", and only a 401 or 403 means a bad key.

Round 2 at b82dc73: clean.

## Nits left

- `resolve(workspaceId, provider)` takes a raw workspace id with no principal, and run and machine principals can read `status`. Both copy `managed/keys.ts`.
- No test covers `validateModelKey`'s dispatch, only `validateOpenRouterKey` with an injected fetch.
- `Infra.validateModelKey` spells out the validator type inline in `compose.ts`.
- The outage refusal uses code `invalid`, which maps to HTTP 400. `ServiceErrorCode` has no 5xx code.

## Beyond the scope

- A tRPC router and a Settings, Model providers section for the key. The task adds the service only.
- A `ServiceErrorCode` for "provider unavailable" (502 or 503), so an outage during `set` is not a 400.

## Steps for Dom

None. Apply migration 0007 with `wrangler d1 migrations apply DB --remote` on deploy, as for any migration.
