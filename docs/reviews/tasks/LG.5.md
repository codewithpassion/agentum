# LG.5 — guest runtime integration boundary

Status: **bounded implementation; LG.5 / R3.8–11 acceptance is incomplete. Production guest execution remains disabled.** This is not a production security approval.

Implementation commit: `2d32d4ab915f8e48c196ba01648c28d13f48b5d3` (fail-closed guest ask, bounded executor, scoped MCP/token/service boundaries, and trusted-presence approval policy).

Started on main `e17376d5`. Read root CLAUDE.md, PRD design 8–9 / phase 3 requirements, LG.2's exact production contracts and ingestion remediation, and LG.3's backend contracts. `docs/tasks/LG.5-guest-runtime-integration.md` is absent from the supplied checkout; the explicit task brief supplies the additional requirements. No task files, schemas, migrations, environment values, secrets or UI mounting were changed. No child agents, push, PR, deploy, paid inference or real sends were used.

## Ask HTTP and service contract

`POST /api/guest/artifacts/:artifactId/ask` uses the existing guest action dispatcher. It requires the request URL's exact Origin and the separate guest cookie; ordinary member routes still do not authenticate that cookie. The body is strict JSON `{text, requestId, agentId?}`: text is trimmed, 1–16,000 characters; request ID is required, 1–200 characters. Agent ID, when supplied, must equal the artifact's selected agent. Workspace, artifact identity, author, role, grant, session, files, reply targets, roster and selection overrides are not accepted.

The dispatcher renews the guest session before invoking the action and passes the NEW credential to the starter. Set-Cookie survives failure responses. The client must keep using its serialized rotating-cookie queue and retain the same request ID for retries. No guest credential is returned in JSON, an event, a URL or a run record.

`createGuestAsk` resolves the current cookie grant, exact workspace/artifact and non-private artifact session. The existing shared session's agent wins; otherwise selection uses handedToAgentId then artifact.agentId. The agent must be active in that workspace. Trusted guest display name comes from guest details. `guestAskPresence` authenticates the new credential against the bound production room, resolves trusted presence/location using the room, then rechecks access. The service constructs the speaker envelope itself and revalidates the grant before `startForGuest`. There is no guest Principal or fabricated on-behalf-of member.

The durable start uses the existing idempotent cap transaction, guest actor, null onBehalfOfUserId, exact scopeArtifactId and shared artifact session, with offerLater. Success JSON is `{runId,sessionId,status}`. The route schedules the offer through waitUntil after the durable insertion; the existing sweep remains the crash backstop. Refusals use the existing generic guest-unavailable 404 response, including cap/readiness/authentication failures. Origin violations remain 403. No approval-answer route exists for guests.

**Production does not supply a run starter to LiveGuestsService or declare runtime readiness.** The new endpoint therefore refuses instead of pretending to have started a run. The workerd test asserts a fresh rotated cookie and zero inserted guest runs for that path. This is not evidence of a successful production-composed HTTP guest run.

## Runtime and capability boundary

Inspection found no existing adapter safe for guests:

- Machine claims deliver secrets, connector MCP servers and library configuration. Their guest refusal is retained.
- Cloud PiRun prepares a home/library, skills/scripts, network/native tools and possibly a Linux VM/computer. Cloud dispatch and resume now explicitly refuse scoped runs before preparing those capabilities, even if readiness is accidentally declared.
- Managed execution uses provider sessions/toolsets and separate credential/skill preparation. Its dispatch/resume and managed-session-token verification now refuse scoped runs.

`RunsService.guestAdapter` permits a separate bounded executor without replacing the ordinary member adapter or changing the runtime schema. Scoped dispatch and cancellation select it when provided. The existing current provenance, role, session, workspace/emergency switch, agent and readiness guards still apply to dispatch, claim, resume and tools. Explicit private guest sessions are refused, and the SQL lifecycle predicate requires the bound artifact session to remain non-private.

`createRestrictedGuestRuntime` implements a local model/tool loop behind the existing RuntimeAdapter interface. The model transport accepts text, JSON tool schemas/results and an abort signal; it returns a strictly validated answer or tool-call DATA record. It receives no agent private instructions, model runtime configuration, skills, files, shell, computer, filesystem, arbitrary fetch or connector ports. Only the adapter dispatches tools. It reauthorizes before/after inference, before tool admission and after tool IO; requires exact artifactId; bounds execution to 20 turns; checks cancellation; and sends output through the real guarded run ingestion/completion APIs. Malformed or unauthorized model output reaches no effect port. A still-authorized refused run is failed; access loss cannot append that failure. Cancel/abandon abort active work. Duplicate dispatches use the real claim boundary.

**This adapter currently executes reads only:** document_read, document_comments and deck_read. It removes all other advertised tools before inference. It refuses resume. Its active map/turn history are local memory, not a durable execution queue or persisted approval continuation. It is a tested bounded adapter core, not a production-certified replacement for PiRun. Its injected model transport is a trusted inference-only adapter, not permission to run arbitrary provider-native actions. Production must not wire readiness from this module's existence.

## Scoped MCP and direct-service guards

`packages/mcp/src/guest.ts` provides a separate MCP server with no general platform ports. It lists only the bound artifact kind's document/deck tools, omits creates and general/native/library/wiki/mail/Slack/connectors/sharing/machine/handoff tools, validates exact artifact and current role on every call, and rechecks after IO. A document_comment addressed back to an agent is refused. Viewer/revoked access cannot execute. General service authorization denies scoped bearer principals except their guarded lifecycle/session/request actions.

Run-token verification reads scope from the stored run, not signed/client claims, and checks current database guest provenance. The shared principal resolver carries that scope and the web bearer adapter additionally runs the real scoped authorization guard, including current emergency/readiness state. Production `/mcp` refuses scoped runs before constructing ANY ordinary tool ports. There is no production scoped tool mounting yet. In particular, the existing live-artifacts access path still derives artifactRunRole from a member onBehalfOfUserId; a guest's null delegation remains denied. The separate current guest guard is not permission to bypass that denial. A future dedicated scoped service/room path must replace that unsupported delegation assumption and preserve LX.5 forceSuggestions before mounting any mutation port.

The token-boundary scan also identified direct token consumers outside the shared resolver. Files (and the skills routes that reuse its authentication), run-library, connector proxy and secret egress now refuse scoped tokens. CredentialsService.runContext refuses scoped runs at the service boundary. Managed session tokens cannot resolve a scoped guest run. No generic file or skill permission is acquired by knowing a valid scoped token. SessionsService composition now receives runs.authorizeScopedRun. RunsService composition receives the actual emergency-switch callback without enabling guest execution.

## Suggestion lane contract (supersedes historical direct guest-agent edits)

Coordinated the canonical ask contract with LG.4 and the following port contract with LX.5 in `t3-daccc9a4`. LX.5 owns persistence, service/room enforcement and changes to server/mcp/live-ports.ts and deck-ports.ts. This lane did not edit those files or allocate a migration.

Guest-agent edit tools are absent even for editor guests unless separate `suggestions.document: LivePort["edit"]` / `suggestions.deck: DeckPort["write"]` ports are supplied. Ordinary direct-edit ports are never used for those tools. Current editor role is still required. Their result metadata passes through unchanged. The bounded runtime additionally refuses mutation execution pending durable suggestion/approval continuation.

LX.5's trusted contract is RoomIdentity.forceSuggestions derived from persisted runs.actorKind === 'guest'; the room normalizes LiveOperationOrigin.mode after fresh authorization on document/deck application. Future scoped production ports must preserve this property and cannot infer mode from model/client arguments. Pending suggestions must not alter accepted room content. Guest human edits retain existing direct editor-role behavior. Guest suggestion decision authorization remains the suggestion owner's service/room responsibility.

## Member approvals with guest presence

RequestsService.needsApproval checks the exact artifact session and a trusted room guest-presence port before consulting stored agent rules. Production presence comes from refreshed room presence, never request/envelope claims. A present guest forces approval. Missing presence wiring conservatively requires approval for artifact-session tools. This applies to all tools, avoiding an incomplete outbound-name taxonomy. Cloud Pi's hook no longer caches negative approval decisions: a guest joining after a previous unruled call is observed before the next call. Positive caching may require an extra approval after a guest leaves; it cannot bypass one. The existing owner-visible/member-only guest Needs-you request behavior is retained and exercised by the service tests.

**R3.11 is not complete across all member execution boundaries.** Daemon and managed runtime approval lists are snapshots, and general outbound services do not all consume a trusted, current approval receipt. The new RequestsService policy plus cloud hook is not a server-side proof that every direct member connector/sharing/mail/Slack write is held. Those paths must be gated at the effect boundary and older runtime capability contracts must fail closed before final acceptance. No claim of all-runtime outbound protection is made here.

## Evidence

All new integration inference and side-effect ports are local captures. The guest runtime test uses the real fully migrated SQLite DB/Atomic adapter, RunsService, guest access/starter/ask services, signed run-token verification, current scoped access, and the real MCP SDK linked transport/server. It verifies cap/retry, guest provenance, trusted speaker, no private agent prompt, successful read-only execution, unlisted/native/foreign-artifact refusal, role loss, emergency refusal, token refusal and revoke during inference. Registry tests exercise tools/list/tools/call, unknown tools, cross-artifact calls, absent direct guest edits, pending-suggestion-port dispatch, role downgrade and access loss during read IO.

The real local workerd guest fixture uses all migrations, D1/R2, production room/guest HTTP services, two network WebSockets and captured EMAIL. It now verifies failed-ask rotation and no guest insertion/charge in addition to its existing room, role, revocation, SSE and checkpoint coverage. No deployed D1 concurrency or real provider/email behavior is inferred from these fixtures.

Final validation on the implementation commit:

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | Passed; no environment files created or modified. |
| `bun run check` | Executed; default cf-typegen regenerated Env without example-derived secret names, so web typechecking failed with the documented missing Env properties. This bare command is not reported green. |
| `bun run --cwd apps/web cf-typegen -- --env-file .env.example` | Passed, explicitly restoring correct local type declarations. |
| Equivalent check: `bunx ultracite check`, `bunx turbo run typecheck --only`, `bun scripts/boundary-lint.ts` | Passed: 1,728 linted files, 11/11 typecheck tasks, clean boundary scan. The duplicate default cf-typegen is the only omitted step. |
| Final `bun run test` | Passed: 12/12 workspace tasks plus 284 root script tests. Web: 3,354 passed, one existing skip; services: 3,202 passed; MCP: 408 passed; zero failures. Includes the workerd guest fixture and final new scoped runtime/MCP/gate tests. |
| `bun run build` | Passed: 5/5 tasks, 204-file dev-only server check. Existing Vite CSS sourcemap warning remains. |
| Client bundle scan for `drizzle` and `cloudflare:workers` | No matching files. |
| `git diff --check` | Clean. |

Final logs: `/home/roboto/.cache/lg5-c5386a30/{typegen,lint,types,boundary,test,build,client-scan}.log`. An earlier execution-environment reset removed temporary /tmp logs/process handles; the final checks above were rerun to this persistent directory. The earlier root-check failure was observed before that reset. No successful paid inference, production guest execution, real Clerk session or external delivery is claimed.

## Remaining acceptance gates

1. A dedicated durable, isolated guest model transport/queue with persisted turns, fresh authorization/token binding on restart, lease/heartbeat/cancel/expiry behavior and deterministic replay. Do not use the ordinary PiRun home/VM/native registry, machine claim or managed session as a shortcut. Safe prompt/history assembly must expose only the exact shared artifact thread and permitted artifact content.
2. Production selected-agent authorization and guestAdapter/readiness/run-starter composition, followed by a successful rotating-cookie HTTP start -> durable dispatch/claim -> run-token MCP read -> streamed completion fixture. Mount the scoped MCP server with current exact artifact/role ports before enabling any path. Current production `/mcp` refusal is intentional.
3. LX.5's persisted-provenance forceSuggestions service/room boundary and scoped suggestion-result ports, plus tests proving guest-origin model edits cannot immediately change accepted content. Preserve forceSuggestions through fresh room identity. No direct guest-agent mutation fallback.
4. Durable owner-visible Needs-you approval/question continuation integrated with the restricted executor; current member-only answer/resume checks on every continuation. The current bounded adapter deliberately refuses resume and mutation work.
5. R3.11 enforcement on daemon/managed and direct outbound service boundaries, with trusted current presence and an approval receipt that cannot be bypassed by cached agent rules or a direct API call. Add captured outbound-port tests for joining/leaving guests and no-real-send refusal/approval paths across each supported runtime.
6. Combined-main independent boundary/security review, merged suggestion/client fixtures, deployed D1 race/revocation evidence and staging product acceptance. Missing external prerequisites must leave guest readiness off. This leaf does not establish final phase 3 or phase 4 acceptance.
