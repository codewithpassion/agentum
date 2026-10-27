# Live artifacts — constrained implementation handoff

2026-10-28. Integrated product head: `c213edfeb71a9c2d3dbac590bb01e8b98d57a130` on local `main`. The user agreed to finish the three active implementation lanes and commit a precise handoff to conserve remaining usage. This closes that bounded work session, **not the complete PRD or release acceptance**. No push, PR, deployment, real email or paid provider inference was performed.

## Integrated scope

- Phase 1: document schema, concurrent editing, authoritative presence, checkpoint/recovery, history/restore, comments, shared asks, scoped tools, attribution and editor actions are implemented with local service/workerd/browser evidence. Markdown creation and static conversion now fetch and store bounded external images. Guarded `document_edit` image ingestion remains missing.
- Phase 2: shared deck core/codec, tools, production rooms, presenter leases, mounted editor, structural rich text, authoritative sparse cells and desktop/phone peer action matrices are integrated. Independent retained-migration remediation approval and signed product acceptance remain open.
- Phase 3: invitations/codes, rotating scoped sessions, guest document/deck clients, caps, lifecycle checks, durable isolated execution, approvals, suggestions, shared status and addressed comments are integrated. Configured cloud, machine and managed agents use dedicated bounded inference with supported workspace provider credentials; ordinary native sessions and private capabilities remain inaccessible. Interrupted committed-cookie recovery remains open.
- Phase 4: suggestions/review, Word/PPTX/PDF routes and controls, element asks, durable member mentions and sandboxed member/guest embeds are integrated. Real provider, delivery, deployed networking, Browser Run quotas and Office fidelity remain acceptance gates.

The earlier independent requirement matrix in [L.A.md](L.A.md) is a point-in-time audit. Its guest comment/runtime and action-inventory gaps are updated by [LG.7.md](LG.7.md) and [L.ACTIONS.md](L.ACTIONS.md); do not mistake the old unassigned entries for the final implementation state. Those newer reports also do not establish full phase acceptance.

## Final three lanes

| Lane | Commits | Evidence and limits |
| --- | --- | --- |
| Reload investigation | `ec66f52d` | [LG.RELOAD.md](LG.RELOAD.md): deterministic fixture negative control; retained navigation lock returns 200, old helper admits a queued rotation and returns 404. 107 browser checks. Fixture fix only; arbitrary interrupted rotation remains a product gap. |
| Actions and image imports | `1bc8f5d7`, `a2050e19`, `86a136d2` | [L.ACTIONS.md](L.ACTIONS.md): desktop/390px peer matrices, theme fill/border and stale selection fixes, bounded deduplicated create/convert images with atomic ownership and lost-ack preservation. Controller reran 13 import tests/44 assertions successfully on merged main. |
| Guest addressed comments/runtime | `b87b4309`, `5f0fd129`, integration `988fe0db`, evidence `80b7c8ef` | [LG.7.md](LG.7.md): atomic comment/run dispatch, receipt-backed scoped replies and answers, isolated configured inference, migration 0032. 143 production-assets browser checks and focused migrated-workerd checks pass with captured inference. No fresh independent security review of this final tranche was commissioned under the agreed usage limit. |

## Remaining implementation work, in priority order

1. **Guest session survival during an interrupted committed rotation.** If the server commits replacement-token state but navigation/termination prevents delivery of its HttpOnly cookie, the browser retains an invalid credential. The fixture navigation-lock correction does not repair this general case. Design coordinated recovery without relaxing current grant/role checks or broadly accepting replay; include deterministic response-loss/restart/concurrent-tab tests and an independent security review. See [LG.RELOAD.md](LG.RELOAD.md).
2. **R1.9 guarded `document_edit` external images.** Markdown image nodes still silently disappear on this path. Resolve/stage images inside the authorized, guarded, idempotent room-operation lifecycle, after guard admission; preserve no writes on guard mismatch, immutable input digests, stable generated IDs across retries, exact ownership/quota, suggestion semantics and scoped-guest fetch refusals. Do not fetch in the MCP adapter before guard admission. Paths and proposed boundary are in [L.ACTIONS.md](L.ACTIONS.md).
3. **Complete independent assurance.** The retained Yjs migration remediation review was provider-blocked; browser success does not substitute for that approval. Final addressed-comment/runtime changes also need independent review before release. Existing bounded reviews apply only to their documented commits and paths; no blanket security signoff exists.

## Deployment and acceptance handoff

No remote migrations were applied. Deployments must include generated D1 migration `0032_lovely_lake.sql` (guest comment binding/effect receipts) and all preceding required migrations, plus the checked-in room/GuestRun Durable Object migrations and bindings. Migration 0032 was tested locally; deployed D1 contention and revocation interleavings remain unverified.

Use the detailed release checklist in [L.A.md](L.A.md): real signing/Clerk with distinct members and guests; D1/R2/room/GuestRun/LOADER/SessionStream/EMAIL/Browser Run; real configured model inference and all member-runtime approval paths; concurrent two-browser-plus-agent editing; real invitations and mention delivery; five-second revocation, hibernation, expiry and checkpoint deadlines; public HTTPS image routing; sandboxed embed revocation; PDF/Office fidelity and quotas. No secret values belong in evidence. Local workerd identities and captured transports do not satisfy these gates.

Agents depending only on a daemon subscription/OAuth login without a supported portable workspace inference credential remain unavailable for guest execution. Unsupported models/providers and missing infrastructure stay disabled. The implementation does not silently substitute a model or expose ordinary native execution.

## Validation and workspace

Final combined-main validation at `c213edfe` passed in one sequential run:

- `bun run check`: 12/12 tasks passed; boundary lint clean.
- `bun run test`: 12/12 package tasks plus 284 repository-script tests passed. Web: 3,391 passed, one existing skip, zero failures. Services: 3,220 passed, zero failures.
- `bun run build`: 5/5 tasks passed; dev-only scan checked 205 server files. Existing CSS sourcemap warning remains.
- Logs: `/home/roboto/.cache/live-integration/final-handoff-{check,test,build}.log`.

These root results include the final merged implementation and its test files; they do not rerun the separate Playwright matrices or establish deployed acceptance. The final agent browser evidence is attributed above. Worktree-specific bare checks sometimes lacked generated secret-derived Env declarations; those reports distinguish explicit `.env.example` type generation from environment-value changes. No environment values were changed in this closing integration.

Existing user files `apps/web/s1.png`, `apps/web/vm1-return.png` and `apps/web/x.png` remain untracked and untouched. Implementation branches/worktrees and their evidence are retained. Do not discard them as part of cleanup without checking for user work.
