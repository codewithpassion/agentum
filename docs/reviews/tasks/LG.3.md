# LG.3 guest routes and production room integration

Bounded implementation of live-artifacts PRD phase 3 R3.1–7/R3.12–13 and design section 9. Guest UI and restricted guest agent execution remain separate lanes. There is no guest ask/run/approval/export endpoint, and composition does not provide a run starter to the guest service. No GuestGrant becomes a Principal.

Implementation began at `3ede1a1c` on the supplied checkout. First substantial implementation commit: `f6f85bdd` (guest routes/service composition, room credentials and publication attribution). Followup implementation and integration tests are committed at `ec99ecdb`. No subagents, other checkouts, direct task-file edits, real email, direct environment/secret changes, push, PR or deployment were used. LX.2 owns the separate member export composition; LX.3 owns mentions. Guest additions remain separate from those modules.

## Client contract

`@repo/protocol/guest` supplies request schemas, result types and URL constructors. Member calls use the typed tRPC `liveGuests` router: `invite({artifactId,email,role,expiresAt?,agentRunsPerDay?})`, `changeRole({artifactId,memberId,role})`, `revoke({artifactId,memberId})`, and admin-only `setEnabled({enabled})`. The existing invitation service enforces owner/admin rights, current workspace scope, supported roles and mandatory future outsider expiry. Named member addresses use verified Clerk emails and a fresh organization-membership lookup; directory failures fail closed.

| Guest endpoint | Contract |
| --- | --- |
| `GET /g/:inviteToken` | Scanner-safe landing JSON: artifact title, inviter/workspace names, role, expiry. No send, consume, rotation, view or other write. |
| `POST /api/guest/:inviteToken/code` | Explicit send action. Always `{accepted:true}` after origin checks, including unknown/disabled/limited/delivery failure. IP comes only from the trusted platform header. |
| `POST /api/guest/:inviteToken/verify` | JSON `{code}`; success `{grant,expiresAt,location}`, with Set-Cookie. Refusals share the generic unavailable response. |
| `GET /g/a/:artifactId` or `GET /api/guest/artifacts/:artifactId/open` | Backend bootstrap JSON: canonical room state/revision, kind/title, grant and trusted inviter/workspace/guest display names. Records a guest open and rotates the cookie. Guest viewer UI is later work. |
| `POST .../:artifactId/rotate` | `{grant}`, with a newly rotated cookie. |
| `POST .../:artifactId/join` | `LiveJoinResult`: participant, role, signed short-lived ticket, and the guest room URL. Ticket and connection deadlines are bounded by grant expiry. |
| `GET .../:artifactId/room?ticket=...` | WebSocket upgrade; exact-origin check, current guest cookie plus independently verified ticket, single-use jti, current role and exact artifact/workspace. Renewal revalidates the stored session reference. |
| `GET .../:artifactId/threads` | Up to 1,000 artifact threads and 100 comments per thread; shared protocol DTOs. |
| `POST .../:artifactId/comment` | `{body,threadId?,anchor?}`. Commenter/editor; trusted room resolves a new anchor; replies cannot replace addressing/anchor. No agent-addressing action. |
| `POST .../:artifactId/resolve` | `{threadId}`; commenter/editor, with exact thread/artifact/workspace binding. |
| `GET .../:artifactId/policy` | This artifact's owned image paths and protected comment ranges. |
| `POST .../:artifactId/images` | Multipart `file`, editor only, bounded 8 MiB raster sniffing. `{url,guestUrl}`: canonical `/files/:id` stays in document state; guest UI fetches through the scoped guestUrl. |
| `GET .../:artifactId/files/:fileId` | Only images in the exact artifact's current image manifest, same workspace, current guest grant, sandbox/CSP/nosniff/no-store. Ordinary `/files` does not gain guest authentication. |
| `POST .../:artifactId/ensure-deck-cell` | `{slideId,elementId,key}`; editor-only production room sparse-cell allocation. Returns `{revision,state}`; artifact ID comes from the path. |
| `GET .../:artifactId/session?after=...` | At most 100 events, ascending ID; only the non-private session with `origin=artifact` and `externalKey=artifactId`. Paginate with the last returned event ID. Payload blobs resolve only after the tenant/session query. |
| `GET .../:artifactId/session/stream` | SessionStream SSE, subscribe before replay; optional Last-Event-ID/after, deduplicated replay pages, 10,000-event reconnect bound. Idle and active streams revalidate the current stable session reference every two seconds and on delivery. |
| `POST /api/guest/signout` | Deletes the matching persisted guest session and clears the matching host cookie, including when guest access is disabled. |

Every authenticated HTTP use rotates through the existing service. Browser clients must serialize these requests (and complete a room handshake before another credential rotation); Set-Cookie applies to error responses too. The host cookie is Secure, HttpOnly, Path=/, SameSite=Lax, has no Domain, and has a twelve-hour server session expiry. Session tokens and OTPs never appear in JSON responses, logs, room tickets or socket attachments. Only invitation URLs contain invitation credentials. WebSockets keep opaque references to server-side session IDs, so ordinary HTTP rotation does not disconnect a valid room. Separate sign-ins still have separate session references.

Guest middleware applies only to `/g/` and `/api/guest/`. Mutations and upgrades require an exact same-origin Origin; cross-site mutations refuse. JSON and multipart bodies are bounded. Responses use no-store/no-referrer/nosniff. Member room/image authentication explicitly ignores the guest cookie; a guest-only header behaves like no member cookie. Other ordinary service routes never resolve GuestGrant.

## Production composition and authority

`composeWith` accepts additive `Infra.guests`, producing lazy `Services.liveGuests`; the production adapter uses the real Clerk SDK and existing EMAIL binding. `guestEmailAdapter` renders escaped HTML and a plain-text alternative with the trusted platform sender. Tests capture the binding calls. No sender/domain onboarding or external mail delivery was attempted.

The guest artifact service performs direct guest authorization, never an invented member call. Comment/resolve writes include a write-time SQL assertion of current session, grant, role, expiry, artifact kind/deletion and workspace switch in the same Atomic batch as the mutation and audit. Thread and image references bind workspace and artifact explicitly. Images are stamped with guest authorship and registered through the existing production room policy. Both request and room adapters read LIVE_GUESTS_OFF on each check. The workspace switch commits its audit and per-artifact invalidation outbox together, then triggers the existing durable maintenance processor.

Production ArtifactRoom independently resolves guest session references on admission, messages, renewal and refresh. Current grant expiry, session expiry/deletion, revoke, role, artifact deletion and both switches are checked. Revocation/role/workspace changes reuse the existing durable invalidation outbox and maintenance sweep. Guest joins durably arm the existing maintenance sweep before issuing a ticket, so later access-change outboxes have a scheduled processor even if their post-commit notification crashes. The shared alarm scheduler retains a two-second guest revalidation deadline even when a refresh or failed checkpoint schedules another alarm. This fixes an alarm overwrite exposed by the expiry test.

Guest socket edits capture authenticated guest publication provenance before mutation; that receipt is persisted in the same room transaction as the admitted state. A no-op sync cannot replace the receipt. Sparse-cell allocation captures the same provenance. Pending checkpoints freeze the receipt and bytes for retry. Trusted system publication consumes that attribution without treating it as authority for new edits; revoked/expired credentials do not erase already accepted state. A later joining editor cannot take authorship of an earlier frozen guest checkpoint.

Artifact author kinds now truthfully include guest in the shared contract, version history label and MCP version metadata. Controller approval explicitly authorized this change. SQL migration inspection found no author-kind CHECK on the artifact version text column; `bun run generate` in packages/db reported **No schema changes, nothing to migrate**. That author-kind change did not need a migration. A later, separately approved schema-owner request consumed 0031 for member mention delivery intents, as described below.

Guest open logs use the existing IP-prefix, referrer-host and user-agent privacy helpers plus trusted Cloudflare place/network metadata. They never retain a full IP or referrer path/query. Invite, OTP send/sign-in and member mutation audits remain the existing atomic service events; comments/resolves and the workspace switch add their appropriate events.

## Executable evidence

- `packages/services/src/live-guests/artifacts.test.ts`: migrated SQLite guest comments/resolution and audit; viewer/cross-artifact/emergency refusals; revoke between preflight and Atomic write; stable room reference across rotation and invalidation on signout; exact artifact-origin/non-private transcript selection.
- Existing LG.0 auth/session suites continue to exercise captured mail, OTP replay/rate limits, rotation, expiry, audit atomicity and the GuestGrant-versus-Principal type test.
- `apps/web/src/server/live-artifacts/guest-infra.test.ts`: captured EMAIL adapter escaping/plain text, privacy metadata, and idle stream subscription cancellation.
- `guest.test.ts` builds a Worker fixture and runs it in real workerd/Miniflare against every repository migration, D1, R2, the production ArtifactRoom and SessionStream. More than 30 standalone assertions cover scanner GET, captured invitation/OTP, host cookies, two actual network WebSocket clients, edit replication, commenter/viewer boundaries, CSRF, cross-artifact reads/images, ordinary member-route refusal, owned image upload/download, production sparse deck cells, exact session replay/SSE, idle SSE revocation, role downgrade, revoke/session expiry/workspace-switch socket closure, emergency sign-in/join refusal, and signout while disabled.
- Checkpoint recovery deliberately fails the publication INSERT after a real guest edit, admits a later editor, revokes the original guest, disables the workspace, restarts workerd, removes the failure, and retries the pending checkpoint. The stored version remains attributed to the original guest, with exactly one recovered publication.
- The existing production member-room/MCP/checkpoint/restart fixture remains in the full web suite.

The complete pre-0031 root test run passed: all 12 workspace tasks plus 284 root script tests (including 3,179 service and 3,334 web tests). Validation after the additive migration is recorded below. No deployed D1 concurrency, production Clerk account or live EMAIL delivery is claimed; those external services are represented by the real SDK/binding adapters and local captures, while database/room/route behavior runs locally against the actual services and workerd.

## Approved schema-owner followup for LX.3

Controller requested a standalone `artifact_mention_deliveries` table while LG.3 validation was finishing. Commit `6ff7a4c6fe18804f3b082f76030d6d420efb3b67` contains `artifactMentionDeliveries` in `@repo/db/schema/live-artifacts`, generated `0031_large_nightmare.sql`, matching snapshot/journal, and a migrated constraint test. Fields are id PK, workspaceId/artifactId/commentId references, userId, createdAt, nullable completedAt/leaseUntil/leaseToken, and attempts INTEGER NOT NULL DEFAULT 0. Unique(commentId,userId) prevents duplicate recipient intents; pending(completedAt,id) supports the same global pending-ID sweep as the existing invalidation/ask outboxes. No address, email, body or rendered content is stored.

Both the controller and LX.3 received the standalone SHA and exact export/types. Delivery implementation belongs to LX.3: claim with current tenant/comment/thread/artifact/member/access joins, attempts < 5 and an atomic attempts increment; acknowledge only the matching leaseToken. As elsewhere in this schema, individual foreign keys do not establish composite tenant relationships, so the delivery queries must prove those relationships afresh. No unrelated delivery framework was introduced here.

The new migrated SQLite test passed seven assertions: default attempt/lease/completion values, recipient uniqueness, all three parent FKs, exact content-free columns and pending index. DB typecheck passed. Migration generation is confined to this schema owner.

## Final validation and main integration

Merged main at `7774bd75` after controller commit `24d93e20` updated schema inventory to 73 tables. This imports the independently reviewed LX.2 exports and controller task/config changes; the only merge conflicts were resolved additively in service composition and package exports. A small `lazyGuestService` helper keeps composed guest and export services within the repository complexity rule. No further schema generation is planned.

The worktree has no `.env`. A bare `bun run check` invokes default Wrangler type generation without the example and loses the secret-name declarations; it therefore fails on missing Env keys. Per the brief, the final equivalent root checks use explicit example-based type generation and omit only that duplicate default generation:

| Command | Result |
| --- | --- |
| `bunx wrangler types --env-file .env.example` in apps/web | Passed; existing values untouched, no environment file created. |
| `bunx ultracite check` | Passed on merged checkout: 1,702 files. |
| `bunx turbo run typecheck --only` | Passed: all 11 typecheck tasks. |
| `bun scripts/boundary-lint.ts` | Clean. |
| `bun run test` | Passed: all 12 workspace tasks and 284 root script tests; zero failures. |
| `bun run build` | Passed: all 5 build tasks, including server dev-only checks. Existing Vite source-map warnings remain. |
| Client scan for `drizzle` and `cloudflare:workers` | Zero matching browser-bundle files. |
| `git diff --check` | Clean. |

The new mention migration initially exposed the existing schema-test hard-coded inventory. The controller fixed that on main before the integration merge; it was not masked or skipped. The final merged DB suite passes 86 tests and the merged services suite passes 3,188 tests. The complete final merged root run passed all 12 workspace test tasks plus 284 root script tests: 3,342 web tests (one existing skipped test), 3,188 service tests and 86 DB tests, with zero failures across all packages. This run includes the final guest-join change that durably arms the existing maintenance object before ticket issuance.
