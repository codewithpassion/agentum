# LR.15 review

Room admission runs the Clerk check once. The route verifies the member and signs a 30 s assertion (`X-Hm-Room-Admission`) bound to the room, the ticket id, the principal and the Clerk session. The room checks it instead of running Clerk again, and still verifies the ticket, consumes its id and re-reads access.

## Rounds

Round 1 (67c46ae), security focus: no forgery, replay, room-binding or revocation hole. One must-fix, a test gap: nothing showed the room skips Clerk on a valid assertion or refuses a wrong header without falling back. Fixed in d318e45 by moving `requestMember` into `room-admission.ts` with an injected authenticator and testing it.

Round 2 (d318e45): clean.

## Other changes

`freshMember` runs the membership list beside the org lookup. The cookie path runs `getSession` beside the member check. The route starts the maintenance DO and the room stub together. A cookie join no longer repeats `authenticateRequest` in credential storage or `resolve` in `authorize`.

## Nits left

- A boundary test for the 2 s `issuedAt` skew.
- The key-separation test would be sharper with a valid payload signed under the raw ticket key.
- `freshMember` now calls Clerk before the allowed-org check, so a non-allowed org costs one Clerk call, and a Clerk error throws where it returned null.
- A revoked session now also runs the member branch in parallel. In the route a thrown error is a 403, not a 401.
- No Durable Object level test of `storeCredential` skipping `authenticateRequest`.
- Clerk facts in the admitted principal can be up to 30 s old when the room acts on them. Later `authorize` and renewals still resolve through Clerk and D1.
- The assertion has no size check on signing (verify caps at 8192 chars).

## Beyond scope

The join still makes one Clerk `users.getUser` through `roomIdentity` (a name lookup), and `access()` runs twice (`live().admit` and `roomIdentity`). Caching the name or passing the access row through would cut more of the 2.2 s.

## Dom

Measure on staging: one join and eight at once against the 3 s bar. No new secrets. It reuses `ARTIFACT_VIEW_KEY`, and the route answers 503 if it is unset. Deploy staging so the route and the room Durable Object ship together.

## Checks

`bun run check`, `bun run test` (only `guest-execution.test.ts` failed, the known load flake, and it passed alone in 91 s) and `bun run build` pass.
