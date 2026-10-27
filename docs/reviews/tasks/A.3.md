# A.3 review: shares, opens, view tokens and access log service

## Verdicts

Round 1 (98af15e): not clean, one must-fix. `shares` returned live `hm_share_` URLs to every member who could open the artifact. Fixed in 3aab9bfa: only the owner and admins get the URL, other members get `<origin>/s/` with no token and nothing is decrypted for them. The same commit makes `open`, `shares` and `views` session-user only and parses `revokeShare` input.

Round 2 (3aab9bfa, fix commit only): the fix was correct. One must-fix from round 1 code: a leak assertion looked for "abc" and matched random hex or UUIDs about 1 run in 10. Fixed in the next commit with the marker `refsecret-q7x`.

Round 3 (fix commit only): clean.

## Contract notes for other tasks

- `ShareGrant` is `{ workspaceId, artifactId, shareId, versionId, kind: "share_grant" }`, exported from `@repo/services/artifacts/shares`. The `kind` tag keeps it apart from every `Principal`.
- The service factory is `createArtifactSharesService({ atomic, clock, db, events, linksOff?, origin, people?, secretsKey, viewKey })`. `secretsKey` is the imported `CryptoKey`, `viewKey` is the `ARTIFACT_VIEW_KEY` string, `origin` starts every share URL (`<origin>/s/<token>`).
- Methods: `open`, `mintTestToken` (run principal, 5 minutes, view row surface `test`), `shares`, `createShare`, `revokeShare`, `views`, `setLinksEnabled`, `openLink(token, ShareRequestInfo)` returning `{ ok: true, grant, response }` (response is a full `ShareOpenResponse`) or `{ ok: false }`, and `prune()`.
- A.6: add `artifactShares` to `Services`, then delete the `sharesService` cast helper in `artifact-shares-router.ts` and the NOT_IMPLEMENTED test for it. The route maps `{ ok: false }` to the one 404 body. Run `prune()` daily, not every minute: `pruneViews` filters on `created_at` alone and no index starts with that column.
- A.10: for a member who is not the owner or an admin, `ArtifactShare.url` is the token-less `<origin>/s/`. The dialog must not show Copy for it (check `createdBy`/role, or the `/s/` suffix). A.1's comment on `artifactShareSchema.url` still says "The copyable link".
- `views` is for the owner and admins only. `createShare` is refused while the workspace switch or `ARTIFACT_LINKS_OFF` is off.

## Nits left

- A deleted artifact, or a link with no resolvable version, is logged with outcome `revoked`.
- The `ARTIFACT_LINKS_OFF` refusal on create reuses the workspace-switch message.
- Salt prune keeps a salt for up to about 3 days (`day < utcDay(now - 2d)`).
- Known-link opens write a salt row even under `ARTIFACT_LINKS_OFF`.
- Timing differs between an unknown token (one read) and a known dead link (salt and view writes).
- The leak test checks the referrer query, not the path `/inbox/`.
- `console.error("People lookup failed", error)` logs the raw error object.

## Ideas beyond scope

- A field on `ArtifactShare` saying whether the URL is withheld.
- An index on `artifact_views(created_at)` if the daily prune gets slow.

## Steps for Dom

None. Nothing in this task needs an account or dashboard. A.6 adds the `ARTIFACT_VIEW_KEY` secret and `ARTIFACT_LINKS_OFF` var.
