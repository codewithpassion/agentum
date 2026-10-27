# LG.6 — mounted guest ask composer

Implemented on main `6fcbe56d` (including LG.5 through `085f2b51`). Read repository guidance, PRD guest triggers/roles and R3.8–11/R4.1, and LG.4/LG.5/LX.5 review contracts. This tranche mounts the product consumer in the actual standalone `/g/a/:artifactId` GuestViewer for documents and decks.

## Product and contract

- `GuestAsk` renders the selected agent, current availability, server-read room context, bounded message input, send/retry notices and member-approval-wait explanation. Viewer and unavailable-agent controls are disabled. Document selection and deck “Ask about selection” actions are wired only while the supported path is available. Human editors, comments, suggestion review, images and embeds retain their existing ports.
- New rotating-cookie `GET .../ask-availability` returns `{available,role,agent?,where?}`. Agent selection shares the actual ask selection code: current shared artifact session agent, otherwise handed-to/author agent. Readiness shares the actual RunsService admission policy and checks the composed adapter, supported runtime/model and configured key. It neither starts a run nor charges usage. Daily cap and all current authority checks remain decisive at POST, including after an earlier successful readiness read. Missing infrastructure/configuration and machine/native/managed runtimes remain unavailable.
- Actual POST remains strict `{text,requestId,agentId?}`. No identity, role, session, roster or selection override is sent. The room acknowledges an attached selection before sending; the server rereads trusted room presence for the envelope. Displayed context is a server echo, not caller-supplied text. Unresolvable locations retain the backend's existing conservative fallback; no fabricated selection is substituted.
- Retry identity and immutable text/selected agent survive an ambiguous acknowledgement and normal same-tab reload in sessionStorage. Retry reuses the original requestId. The guest can explicitly discard a saved retry, with notice that the earlier request may still run. Signout clears the current artifact's saved retry. Storage-disabled browsers retain in-memory retry identity only.
- All guest HTTP operations use the existing host-wide `guestHttp` queue and browser cookie lock. SSE uses queued fetch rather than EventSource auto-reconnection: the lock covers its rotating response handshake, then releases while the stable-authorized body is read. Unmount aborts the stream; polling provides catch-up/reconnect. Stored event IDs deduplicate live/replay/poll results and order the shared transcript. Streaming events directly update shared authors, answers, waiting and completion status, including while transcript HTTP is held.
- Requests needing approval say a workspace member must answer in Needs you. Guest UI exposes no approval-answer controls or member navigation. Existing individual suggestion decisions remain governed by current human edit authority. Pending guest-agent edits remain suggestions and do not change accepted room bytes/revision.

## Narrow integration corrections

No executor, inference, scoped MCP, approval or room-application core was changed. Two backend presentation/admission additions were necessary: factor the existing read-only runtime/agent admission checks out of `startForGuest` for readiness (the actual start repeats them), and apply the existing server actor-name resolver to guest transcript history. Guest names now survive reload and cannot come from payload actorDisplay claims. Member names without a supplied directory retain the existing role fallback.

The real browser exposed the document cursor plugin clearing explicit attachments on blur/remote editor updates. `TicketedRoom` now retains the canonical cursor for an explicit ask/comment attachment until `clearSelection`; ordinary un-attached caret presence stays live. A client transport regression test verifies retained outgoing context and explicit clearing. No server selection override was introduced.

The pre-existing guest review browser fixture seeded a member run with the guest-only scope field. Current LG.5 correctly rejected it. Its member fixture now omits scope_artifact_id, retaining its authenticated member identity, active session and actual production room suggestion operations. The new execution fixture uses genuine guest starts, GuestRun and scoped MCP throughout.

## Verification

The new `browser-check.ts --production-assets --execution` mode serves the emitted production guest entry and drives the existing explicit captured-model fixture. It uses fully migrated local D1/R2, production rotating-cookie routes, real rooms, GuestRun, signed scoped MCP, owner requests/member answers, persisted suggestions and shared SessionStream SSE. Only the existing model leaf and email capture are substituted; no service callback replaces execution.

The document/deck desktop (1280×800) and phone (390×844) matrix covers supported availability, machine/unsupported-model refusal, selection/context echo, strict ask payload, unreadable acknowledgement, same-identity retry after reload, one charged run, real owner approval waiting, absence of guest approval buttons, member answer/resume, completion, shared guest author after reload, byte-identical accepted content while pending, persisted suggestion review, current downgrade across an in-flight ask, 404 refusal/no extra run, reconnect with disabled viewer retry, horizontal fit and no browser exceptions. During member resume, a real old transcript HTTP response is held until the completion is visible, establishing direct SSE consumption rather than polling-only success.

Reload evidence waits for the browser cookie lock before navigating. Abrupt external reload during a one-use credential request retains the existing backend limitation; this tranche does not claim to solve it. Early fixture attempts exposed this race and were corrected to drain the rotating response before reload.

Final command results and logs are recorded below. No real Clerk/provider, deployed/staging, external delivery or paid inference acceptance is claimed.

No docs/tasks, schema/migration, environment values, keys or secrets changed. No real provider/model call, email, deployment, push, PR, task creation or subagent was used.

### Final results

| Check | Result |
| --- | --- |
| Actual production `/g` execution browser matrix | **86 checks passed**, document/deck at desktop/phone sizes; real GuestRun, scoped MCP, approval/member resume, SSE with polling held, reload, selection, readiness and current refusal. |
| Existing production `/g` collaboration/review/embed browser matrix | **62 checks passed** after correcting the member fixture's obsolete scoped-run seed. Existing denied-directory/guest-refusal diagnostics are retained in the log. |
| Root `bun run test` | **12/12 workspace tasks**, **284 root tests**; web **3,369 pass/one existing skip**, services **3,220 pass**, zero failures. |
| Focused final client checks | **12 pass**, 54 assertions (selection transport and incremental SSE decoder). |
| Final guest history service regression | **5 pass**, 16 assertions; exact private-session exclusion and trusted guest name despite forged payload display. |
| Root `bun run build` | **5/5**, dev-only scan checks 205 server files; existing Vite sourcemap warning. |
| Explicit example typegen, then root `bunx turbo run typecheck --only` | **11/11 typechecks pass**. No environment file copied or modified. |
| `bunx ultracite check` | **1,772 files**, clean. |
| Root boundary lint, client `drizzle|cloudflare:workers` scan, `git diff --check` | Clean; zero client matches. |

Logs: `/home/roboto/.cache/lg6-f423bd4d/`. The `lg6-browser-final.log` and `lg6-browser-regression.log` contain the final browser tallies; `lg6-test-final.log`, `lg6-build.log`, `lg6-types-final.log`, `lg6-typegen.log`, `lg6-lint-final.log`, `lg6-focused.log`, `lg6-service-focused.log`, `lg6-boundary.log` and `lg6-client-scan.log` contain the other results. The established env-free default cf-typegen limitation remains: this tranche uses the explicitly authorized `.env.example` generation and separate full check stages, and does not claim a green bare `bun run check`.

Local product ask mounting is complete. Deployed/staging concurrency, real configured inference/delivery and full authenticated Clerk acceptance remain external gates inherited from LG.5, not implied by local captured-model evidence. Unsupported native/machine/managed guest execution remains refused.
