# L.4a implementation status

Incomplete. Only the room-ticket cryptographic helper is implemented; this is not a live service and must not be wired as one.

`@repo/services/live-artifacts/ticket` exports `signRoomTicket(claims, key)` and `verifyRoomTicket(token, key, { artifactId, workspaceId, nowSeconds })`. It uses the existing Web Crypto HMAC-SHA-256 and base64url patterns, validates the strict protocol claims, and rejects wrong signatures, room bindings, future issuance and expired tickets. The caller must supply a real secret. The room must atomically consume `jti` after verification and enforce connection expiration; this helper does neither.

Focused ticket tests pass (2 tests). Root build passed. Root check initially failed because the ignored web `.env` was missing; `.env.example` was copied only after checking it was absent, and check was rerun. The rerun of root check passed. Root test was still running at the time of this record.

Still required: the requested `createLiveArtifactsService`, typed room/content ports, same-workspace authorization and role enforcement, document creation/conversion, persistence adapters and checkpoint manifests, restore and access invalidation, real database integration tests, and the exact integration API for L.4b/L.4c/L.7. L.4a and L.4 remain incomplete. No schema, task file, deployment, PR or push changes were made.
