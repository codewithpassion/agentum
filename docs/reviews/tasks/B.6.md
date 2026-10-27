# B.6 Live links, review

Branch task/B.6-live-links. Verdicts by round.

- Round 1 (a67afd64): must-fix. The rate limit counted before it wrote the call's row, so calls at the same moment could all pass an old count.
- Round 2 (d7054c05): clean. The row is now written first and counted (limits are strictly greater than), and every later decision updates that row. The reviewer proved the limits hold under concurrency.

## What was built

- `createShare` takes `dataMode: "live"` for the artifact owner alone (an admin who is not the owner gets 403). It records `granted_by` and `live_tools`, a deduplicated subset of the tools the link's version has approved. Limits rows (`<tool>#<json>`) are filtered out and never count as tools.
- `callLink(token, { tool, arguments }, request)` in `packages/services/src/artifacts/shares.ts` checks everything at call time with no cache: link alive (not revoked, expired, deleted, workspace switch on, `ARTIFACT_LINKS_OFF` off), rate limits, live mode, tool in `live_tools`, tool in the shown version's plain approved grants, `granted_by` still the artifact owner, workspace org in `allowedOrgIds`, and an uncached Clerk membership check (`Infra.isOrgMember`, new). Then it runs B.5's `ToolRunner` as `granted_by`. A missing runner or membership check refuses.
- Limits come from the access log, so they are exact and need no binding: 60 a minute and 1,000 a day per link (rolling), 10 a minute per visitor hash. Visitors with no IP share one bucket.
- One `artifact_views` row per call, surface `live_call`, with the tool key. Outcomes: `ok`, `refused`, `rate_limited`, `error`, and `revoked`, `expired` or `disabled` for dead links. An unknown token writes nothing.
- `POST /api/share/:token/call` (200 `{ result }`, 403, 429, 404) and the controller's addition `POST /api/share/:token/storage` (`get` and `list` of the shared area, writes 403, dead link 404) sit next to the open route in `apps/web/src/server/routes/artifacts.ts`.
- Rate limiting at the route: the share-open limiter's pattern, the `SHARE_OPEN_LIMIT` binding under its own key prefixes (`call:` and `storage:`). It is a flood guard only (about 30 a minute per token and per IP prefix, from the binding's config). It does nothing when the binding is missing. The exact limits above live in the service. B.8 may add a dedicated binding.
- Small shared edits: `Infra.isOrgMember` and `Infra.toolRunner` (tests) in compose.ts, `clerkOrgMemberCheckFresh` in clerk-membership.ts, `ShareLookup` gained fields and two query functions in `artifact-shares.ts`, `shareStorageInputSchema` in the protocol.

## Contract notes for other tasks

- A tool that fails for the granter (needs auth, connector error, too large) answers 502 `{ error }` with no detail, outside the PRD's four statuses, so a visitor learns nothing about the owner's connections.
- Storage reads write no access-log row (they are not tool calls) and have only the flood guard as rate limit.
- A pinned link checks the pinned version's grants, not the current version's. A link that follows the artifact checks the current version.
- Argument limits (`<tool>#<json>` rows) are not enforced on live calls, as with B.5's member calls. Neither path checks them yet.

## Nits left

- Calls refused by the flood guard (429) or a bad body (400) write no row.
- If the count query throws, the call's row stays `ok`.
- In-flight calls that will be rate limited briefly count toward the limits.
- The per-visitor limit resets when the User-Agent changes or the daily salt rotates.
- `countLiveCalls` counts `disabled` rows, so a switched-off period weighs on the day limit.
- The 64 KB body cap counts characters and applies after the body is read.
- `shareStorageInputSchema` is not strict and has no key length cap.
- The concurrency test would also pass if every concurrent call were limited.
- A live link can be made with no tools (the protocol schema requires at least one, so only direct service use).

## Ideas beyond scope

- Enforce argument limits for member and link calls in one place.
- A dedicated rate-limit binding for calls (60 a second window) in B.8.

## Steps for Dom

None for this task. B.8 mounts nothing new: the routes are already in `artifactRoutes`. The Worker needs `CLERK_SECRET_KEY` (already set) for the membership check.
