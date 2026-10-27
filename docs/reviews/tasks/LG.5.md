# LG.5 — restricted guest execution integration

Status: implemented for the dedicated cloud inference executor; unsupported guest machine/managed/native paths remain disabled. Independent combined-main review and staging acceptance remain gates. This record supersedes the earlier read-only foundation report (`2d32d4ab`, `37e0ae48`).

Implementation tranche `ac6f85eb`, durable queue follow-up `a2132d6d`; merge `c489b70f` integrates current main `7469b4bc`, including LX.5 through `4af346fe` and the public-image/guest-response corrections. Read the PRD design 8–9/R3.8–11, LG.2 exact lifecycle/provenance contracts, LG.3 backend contract and LG.5 task. Phase-4 suggestion requirements supersede historical direct guest-agent edits. No docs/tasks edits, D1 schema changes, environment values, secrets, paid inference, external sends, subagents, push, PR or deployment. The new SQLite `GuestRun` Durable Object uses Wrangler migration v9; D1 migration 0032 remains unused.

## Supported production path

`POST /api/guest/artifacts/:artifactId/ask` accepts strict `{text,requestId,agentId?}` through the existing same-origin guest action dispatcher. It renews the separate HttpOnly guest cookie first and passes the new credential to the service. The client must serialize rotating requests and reuse requestId on retries. Success remains `{runId,sessionId,status}`; authentication, cap, role, selection and readiness refusals remain indistinguishable guest-unavailable 404s (Origin refusals are 403). No guest approval-answer endpoint exists.

Selection uses the current shared, non-private artifact session agent, otherwise the artifact's handed-to/author agent. Active workspace agent, current grant and trusted room presence/location are reread. Speaker identity comes from guest details, never input fields. `startForGuest` uses the existing transactional idempotent daily-cap charge, immutable guest actor/null member delegation, exact artifact and stable guest-session provenance. Dispatch is scheduled after durable insertion; the existing sweep recovers unoffered runs.

Composition supplies an explicit **dedicated** guest adapter only with a GuestRun port, signing key, public base URL and live-room infrastructure. Selected-agent policy additionally requires cloud runtime, a supported configured model and an existing workspace provider key. Missing prerequisites fail closed. Ordinary PiRun, VM, machine claim and managed sessions still refuse guests. The `/g` components and review mounting remain owned by the UI/suggestion lanes; this change supplies the actual HTTP execution contract without replacing those components.

## Isolation and durability

`GuestRun` is a separate SQLite-backed object named by immutable run ID. It never starts PiRun/a daemon/VM, creates a home, loads private agent instructions/runtimeConfig, delivers agent secrets/connectors/library/skills, evaluates generated code, or registers native tools. Its only model operation is the existing configured `createCloudModels` completion abstraction with workspace-scoped credentials resolved at inference time. Model input is the trusted speaker envelope, bounded exact shared-thread user/assistant history, permitted tool schemas and prior scoped results. Tool descriptions and artifact content are data. No provider-native tools are passed. Credentials are absent from stored turns/model input.

Strict JSON replies select answer, scoped tool intent or member question. There are at most 20 turns, 4096 output tokens per inference, a 45-second inference timeout, 200k-character context limit, 8k tool-input limit and 64k captured tool-result limit. Unsupported/malformed contracts fail the run; transient failures have a persisted five-failure bound. There is no generic fetch/shell/file/network/native executor and no fallback to one.

The object persists turn, sequence, pending intent, request ID, result history and failure count. An alarm is armed before I/O. Queue contention waits durably without inference or consuming the execution-failure budget; the adapter offers the next queued run on completion, with alarms/sweep as recovery. Claims/heartbeats use the real RunsService and a 120-second lease; an expired/missing lease cannot be revived by a recovery heartbeat. Terminal/cancelled runs stop. Current scoped authorization/switch/session/grant/agent checks run at dispatch, claim, recovery, inference return, tools, ingestion, completion and approval continuation. Revocation/downgrade/signout can stop a held continuation without exposing an output. The existing lifecycle SQL predicates and ingestion race fix remain in force.

Every tool intent/question enters actual owner-visible/member-only Needs you. Persisted request/outcome and alarms survive object/worker restart; current member answers wake the dedicated adapter. The next step rereads guest authority. Stable toolCallId is `${runId}:${turn}` and transcript sequences are deterministic. The persisted effect intent precedes MCP invocation; a crash after room commit retries the same call ID. Room suggestion change IDs deduplicate the effect. Inference itself can repeat after a crash before its reply is persisted; it has no side-effect ports.

## Scoped MCP and suggestion composition

`guest-run-rpc.ts` calls the actual production bearer-authenticated `/mcp` route with a freshly signed run token. Scope comes from the stored run and current provenance, not token/model claims. Scoped routing constructs only `guestMcpServer`, never ordinary platform ports. Each call checks the exact artifact/current role and the service guard. Registered tools are only document_read/document_comments/document_edit for documents or deck_read/deck_write for decks. Viewer access is refused; commenters receive no edit tools. Unlisted tools and foreign artifacts fail at both registry and service boundaries. Non-idempotent document_comment mutation is intentionally unavailable to the executor.

The additive service access port is `scopedRunAccess(principal,artifactId,write?) -> {role}` backed by `runs.authorizeScopedRun(principal,runId)` and exact DB guest provenance. It replaces the unsupported null onBehalfOfUserId delegation only for a real scoped run. Missing scoped wiring and legacy fabricated scope rows are denied. General token files/skills/library/proxy/egress/credential paths retain guest denial. Scoped restore/checkpoint submission, external image import/upload, deck-cell creation and workspace embed discovery also fail closed at the service boundary.

LX.5 owns ordinary live/deck ports and room suggestion persistence. Their shapes are unchanged: after fresh scope checks AND `roomIdentity.forceSuggestions === true`, the dedicated mount binds `suggestions.document = live.edit` and `suggestions.deck = deck.write`. Existing persisted ancestry traversal and fresh room identity spreads are preserved. Room application normalizes mode after current authorization; caller mode cannot select direct mutation. Pending document/deck edits do not alter accepted content. Guest human editing/review retains its existing role-based rules.

## Current-presence member outbound approvals

RequestsService reads the stored artifact session and refreshed trusted room guest presence before agent ask rules. Missing presence wiring conservatively requires approval for artifact sessions. Cloud hooks do not cache negative decisions. No client roster/envelope/config claim establishes guest presence.

The daemon advertises `current-approvals` and asks the real machine run endpoint before **each** native/tool call. Lookup failures deny. `always_allow` cannot bypass current policy. Artifact-session claims require both requests and current-approvals capabilities before token/secrets/library delivery; older daemons refuse those claims. The latest executor keeps the gate even if a malformed claim omits toolRules while declaring current approval support.

Managed artifact sessions configure every native/MCP toolset with always_ask, including calls otherwise covered by saved allow rules. This intentionally stronger policy covers guests joining after remote configuration; other sessions retain existing policy. Guest managed sessions remain unsupported.

Direct Slack post, connector forwarding (all non-handshake protocol effects), and secret egress consume a member approval at the effect boundary. Approval payloads carry a server-generated HMAC binding to canonical raw effect/run/tool data using the existing signing key. Redacted/truncated display equality cannot authorize another effect. Fallback receipt IDs are also checked against the expected server binding; a forged/reused ID cannot substitute a harmless display. Conditional consumption permits one effect per approval, including under concurrent retries. A caller without an approval receives a conflict/Needs-you item and must retry that exact effect after a member answers. Transport failure after consumption requires a new approval. Slack binds the resolved channel/posted text; egress binds method, URL, forwarded headers and exact body bytes.

Mail uses its existing durable held-draft/member approval/release path. Current trusted presence forces external mail to be held even when a recipient has an allow rule. Sharing/audience creation paths remain member-only. These guards govern newly invoked effects; they do not retroactively recall an already executing native process or a send already accepted by an external system. No external sends were used for verification.

## Evidence and acceptance limits

The new workerd fixture uses all real migrations, D1/R2, production guest HTTP/room services, GuestRun, signed bearer MCP and shared SessionStream SSE. Only the model leaf and email transport are explicit local captures; there is no production fake-mode switch or provider call. It verifies rotating-cookie start/idempotency/caps, immutable provenance, actual owner Needs-you persistence across full worker restart, member answer/resume, real scoped document/deck suggestions, stable-step retry after lost executor acknowledgement, shared SSE completion, native/foreign-tool and unsupported service refusal, current downgrade cancellation and no added suggestion after downgrade. Existing guest/room fixtures continue to cover actual role/revoke/switch/race/restart behavior. The production inference adapter also has a captured configured-model test proving it passes no native tool registry or credentials into model data; core tests cover expired-lease refusal and persisted reconstruction.

Approval/service tests cover trusted join after an unruled call, fail-closed daemon lookup, managed wildcard policy, old-daemon claim refusal, direct captured Slack refusal, forced held mail despite saved allow rules, concurrent one-use receipt consumption, payload substitution and forged-receipt IDs. Older member review fixtures now use proper member artifact sessions rather than fabricated guest scope.

Validation logs are under `/home/roboto/.cache/lg5-c5386a30/`. Root check was executed: bare default cf-typegen omits example-defined secret Env properties and therefore web typechecking fails. Explicit `bun run --cwd apps/web cf-typegen -- --env-file .env.example` restores local types without changing environment values; lint, all typechecks and boundary scan are run separately. Root tests/build and final check totals are recorded below after completion.

Remaining gates:

1. Controller's independent combined-main boundary/security review, then authorized staging acceptance with real bindings/durable migration and deployed D1 concurrency/revocation behavior. Local workerd does not establish deployed evidence.
2. UI lane product ask control/availability presentation using the stable rotating HTTP contract; existing `/g` review mounting was preserved. No component/page ownership was taken over.
3. Ordinary guest native/machine/managed runtimes, generalized network/files/shell, non-idempotent comment mutation and guest approval answers remain intentionally unsupported. They must not be enabled by removing the existing refusals.
4. Configured production inference/provider and external email/delivery operation were not exercised; no secrets were requested, values changed or deployment performed. Missing configuration keeps starts unavailable.


## Final verification

| Check | Result |
| --- | --- |
| Post-merge `bun run test` | 12/12 workspace tasks; 284 root script tests; web 3,367 pass/one existing skip; services 3,220 pass; no failures. |
| Queue follow-up | Four core cases plus real migrated-D1/workerd HTTP approval/queue/restart/MCP/SSE fixture pass (5 tests); queued contention performs no inference and consumes no failure budget. |
| Daemon/native follow-up | 131 focused approval/executor/machine-claim tests pass. |
| Explicit `.env.example` type generation, then `bunx turbo run typecheck --only` | 11/11 pass. No environment values changed. |
| `bunx ultracite check` | 1,768 files; clean. |
| Latest `bun run build` | 5/5 tasks, 205 server files checked. Existing Vite CSS sourcemap warning only. |
| Boundary/client scans and `git diff --check` | Clean; no drizzle or cloudflare:workers matches in the client bundle. |
| Bare `bun run check` | Executed; default cf-typegen omits example-derived secret Env fields. This command is not reported green; explicit example-based typegen plus the individual checks above passed. |

Logs: `merged-{test,build,lint,types,boundary}.log`, `queue-integrated.log`, `daemon-final.log`, `root-check.log`, `typegen.log`, and `client-scan.log` under the cache directory above. The first post-merge typecheck overlapped Vite replacing dist and reported disappearing generated files; the sequential rerun passed. A standalone web test from the root lacked the package's Cloudflare preload; the package-context run and root package test orchestration passed. No deployed or paid-provider evidence is claimed.

## Independent combined-main review — 2026-10-28

Reviewed merge `6fcbe56d` (including `085f2b51`) against R3.8–11 and R4.1. This is a bounded local review, not acceptance. The UI ask mount is concurrently owned elsewhere and its absence was not treated as a backend finding.

### Findings

1. **High — connector protocol handshake bypasses guest-present outbound approval.** `apps/web/src/server/routes/proxy.ts` `guardOutbound` exempts any parsed `initialize`, `notifications/initialized`, `tools/list`, or `ping` POST, without constraining the bytes or forwarded headers. `describeCall` accepts arbitrary ordinary keys and values, and `sendUpstream` forwards the original body and selected caller-controlled headers to the connector. In a member run whose artifact has a guest present, send `initialize` with private text in `params.clientInfo.name` (or another permitted field/header): the connector receives it without a Needs-you decision. Require approval for arbitrary outbound content, or construct and validate a strictly bounded protocol-only handshake and headers before exemption. Test the real proxy with trusted guest presence, captured transport, and data in both body and forwarded headers.
2. **High — connector approval does not bind the complete forwarded effect.** For `tools/call`, `guardOutbound` binds only `params.arguments` and connector/tool name; the raw JSON body and `accept`, `content-type`, `last-event-id`, `mcp-protocol-version`, and `mcp-session-id` headers are forwarded. After approval for an invocation, retry with identical arguments but changed `params._meta`, other extra JSON fields, or a forwarded header: the same receipt can authorize different bytes sent to the connector. Bind canonical method, destination and exact forwarded body/header values (or strip all unbound data), and test substitution and one-use concurrency through the real route. This is distinct from the egress path, which binds its forwarded headers and body.

### Evidence and limits

A focused local Bun probe extracted the actual `describeCall` and `guardOutbound` functions from the reviewed source and used a captured `requireOutbound`: an `initialize` carrying private text made zero approval calls; two `tools/call` bodies with different `_meta` values produced identical approval inputs. The route forwards the original bytes (`sendUpstream`); this probe did not exercise D1, a live connector, or an external send. Dependencies were absent in this checkout, so no full suite or workerd fixture was run; the root suite remains controller-owned. The review inspected the dedicated GuestRun persisted phases, current provenance predicate, scoped MCP loopback, model isolation, presence checks and Wrangler binding/migration declarations, but does not certify every authorization race, retry path, or deployed binding. No provider, environment, schema, migration-history, secret, deployment, or external-send action was performed.

The controller must resolve and independently retest these findings before acceptance. Existing gates remain: controller combined-main review and suite; concurrent UI ask mounting and its integration; authorized staging acceptance of actual bindings, durable migration, D1 concurrency and revocation; and separately authorized real inference/delivery validation. Local source review does not establish those gates.
