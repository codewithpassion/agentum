# P.2 review

Round 1 at 73992b3: clean.

The browser check ran before review, with dev login on a local dev server. A key was added and its hint (last four characters) showed. A status call over tRPC and the server-rendered page held no key, the dev log held no key, and Remove returned the page to "No key set".

## Nits left

- `settings.model-providers.tsx` copies `settings.managed-agents.tsx` almost line for line (`errorMessage`, `keyState`, the form and handlers). A shared key-form component could replace both.
- The router's `max(512)` lets a 512-character key through, and the service refuses `>= 512`, so the user sees the service message. `managed-keys-router.ts` has the same off-by-one.
- The page shows `error.message` as is, so a zod rejection (a key over 512 characters) shows raw JSON issues in the alert. The managed-agents page does the same.
- The router test does not assert that the `remove` response leaves out the key (the service returns a constant).
- The router test sets no `validateModelKey`, so a provider rejection or outage reaching the client is covered only by the P.1 service tests.

## Beyond the scope

- A shared key-form component for the Anthropic and model-provider pages, once a second provider exists.
- Showing a friendly message for zod input errors in both key pages.

## Steps for Dom

None. The check in dev used the OpenRouter key from `apps/web/.env.local` for the live validation, and the key was removed afterwards.
