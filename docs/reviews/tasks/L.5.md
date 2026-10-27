# L.5 — Live document MCP tools

Implemented in the assigned `t3/live-document-tools` worktree, without engine,
service implementation, DB, compose, room binding or application adapter changes.
L.7 supplies the app adapters; the package server is ready to register them for
Pi, Managed Agents and machines through the existing MCP endpoint.

## References reviewed

Read `CLAUDE.md`, `docs/tasks/L.5-live-tools.md`, the live artifacts PRD (especially
section 6 and R1.22–R1.28), `packages/protocol/src/live.ts`, artifact tools/ports,
`defineTool`, registration's dry-run gate and the shared approval-key patterns.
Before writing the tools, reviewed the current Proof SDK
[`AGENT_CONTRACT.md`](https://github.com/EveryInc/proof-sdk/blob/main/AGENT_CONTRACT.md).
It documents create/read/operate, scoped credentials, collaboration sessions and
mutation idempotency; it does not define Harbourmaster's block-op wire format.
No Proof source code was copied. The strict operation schemas below make the
PRD's behavior concrete for adapters without implementing document operations.

## Public package API for L.7

Import `LivePort` from `@repo/mcp/ports` or `@repo/mcp/tools/live`. Supply it as
`McpPorts.live`, alongside the existing `McpPorts.artifacts`. Each port is already
bound to the authenticated principal/workspace, agent, run and tool-call identity;
none of those identity fields is accepted from tool input.

`harbourmasterTools` registers `document_read`, `document_edit`,
`document_comment`, `document_comments` whenever `live` is supplied. The package's
`TOOL_NAMES` includes all four names. Read-only callers get only the two read tools.
No separate runtime-specific registration is necessary. `artifact_create` remains
in the existing artifact group and receives both ports. Without a live port its
static behavior is unchanged and a document request fails clearly.

All schemas and input/result types are exported from `@repo/mcp/tools/live`:

| Port method | Input | Result |
| --- | --- | --- |
| `create` | `DocumentCreateInput`: `kind: "document"`, `title`, optional `description`, `markdown`, `message` | `DocumentCreated`: `artifactId`, `url`, `revision` |
| `read` | `DocumentReadInput`: `artifactId`, optional `blockId`, `sinceRev`, `atRev` | `DocumentReadResult`: `artifactId`, `revision`, `blocks`, `deletedBlockIds`, `present` |
| `edit` | `DocumentEditInput`: `artifactId`, nonempty `ops`, optional `status`, `summary` | `DocumentEditResult`: `revision`, `changeId`, `skipped: {index, code, reason}[]` |
| `comment` | `DocumentCommentInput`, described below | `DocumentCommentResult`: `thread`, optional newly written `comment` |
| `comments` | `DocumentCommentsInput`: `artifactId`, optional `to: "agent"`, `answered`, `cursor` | `{items: LiveCommentThread[], next?: string}` |

`artifactCreateInputSchema` is exported from `@repo/mcp/tools/artifacts`.
`kind: "document"` accepts optional markdown (including empty markdown); it rejects
`files`, `fromLibraryPath` and `entry`. Static kinds reject `markdown` and keep
their existing file validation, defaults, port and result format. Live creation
returns only artifact id, revision and URL, excluding unexpected credential fields.
It does not direct the agent to run the static artifact browser test.

A `DocumentBlock` has `id`, eight-hex `hash`, `rev`, `type`, `text`, optional
`markdown` (full block/table content) and `intent` (pending block plan). Reads
render these and document revision as text, plus presence including positions.
The adapter performs revision selection/delta projection; deleted block ids must
be returned for delta reads. Presence and comments use the protocol's existing
types, including guest authors and detached anchors.

### Document operation wire format

`documentOperationSchema` / `DocumentOperation` are reusable by adapters.
All objects are strict. No force option, caller identity, or arbitrary attribute
bag is accepted. `ops` is applied in order as one agent change.

- Target: `{blockId}` or `{find, nth?}`. `find` is exact text, `nth` is one-based;
  ambiguous or missing text must fail rather than choose a broader match.
- Guarded target: `{blockId, ifHash, ifRev}` or `{find, nth?}`. Hash is eight hex
  characters; revisions are nonnegative integers. Whole-block replacement and
  deletion cannot omit either guard. Move, set and table ops also use this guard.
- Content: exactly `{markdown}` or `{text}`. These are strings for the shared
  document schema to parse/sanitize, never unchecked document JSON.
- Replace: `{op: "replace", target: guardedTarget, content}`.
- Delete: `{op: "delete", target: guardedTarget}`.
- Insert: `{op: "insert", target?, position?: "before" | "after", content}`.
  Omitted target appends; omitted position at a target means after. Insert content
  may instead be `{type: "pending", intent}`. Filling a pending block is a guarded
  replace against its existing id, never a new insert after it disappears.
- Move: `{op: "move", target: guardedTarget, destination: target, position}`.
- Set: `{op: "set", target: guardedTarget, attrs}`. At least one of `type`,
  `level` (1–6), `checked`, `start` (positive), `language` is required. Supported
  type values: paragraph, heading, bulletList, orderedList, taskList, blockquote,
  codeBlock. Engine validation decides which attributes apply to the target.
- Table insert: `{op: "table_insert_row" | "table_insert_column", target:
  guardedTarget, index, cells: string[]}`. Cells contain plain text and index is
  zero-based. The engine checks dimensions/index against the actual table.
- Table delete: `{op: "table_delete_row" | "table_delete_column", target:
  guardedTarget, index}` with a zero-based index.

For example:

```json
{
  "artifactId": "5b1c1a3e-0a52-4f5f-8f07-0b3d8e9a1c11",
  "status": "Writing risks",
  "summary": "Fill the planned Risks section",
  "ops": [{
    "op": "replace",
    "target": {"blockId": "1.2", "ifHash": "1234abcd", "ifRev": 2},
    "content": {"markdown": "## Risks\n\nVendor delay is the main risk."}
  }]
}
```

`summary` is optional; the service must derive a one-line history summary when
omitted. `status` is passed unchanged for room awareness, with a 200-character
limit. The engine/service owns guards, relative positions, sanitization, atomic
application, change attribution and awareness clearing. No duplicate engine or
service logic is present in MCP.

### Comment wire format and state ownership

- New thread: `{artifactId, quote, body, blockId?, nth?, to?: "agent"}`. Quote
  must have 3–6 words. The adapter resolves the quote to protocol relative
  positions, rejecting missing/ambiguous matches.
- Reply: `{artifactId, threadId, body}`. It cannot silently retarget an existing
  thread: quote, blockId, nth and to are rejected with threadId.
- Answer: `{artifactId, threadId, answered: true, body?}`. The service must verify
  artifact binding and that the thread is addressed to this agent. This is not
  resolution, reopening, or clearing another participant's answered state.
- Inbox: `{artifactId, to: "agent", answered: false, cursor?}`. The adapter
  filters using persisted state and preserves pagination, guest attribution,
  quotes and detached anchors. No post-filtering by MCP loses page entries.

Detached threads retain discussion and their original quote. Descriptions teach
asking for context or replying to the same thread, not inventing an anchor or
silently resolving it. The service enforces comment-anchor deletion protection;
tools preserve its refusal.

### Errors, approvals and dry runs

Expected adapter failures must be `ToolError` from `@repo/mcp/result` so the code
and guidance survive the safe error boundary. Added codes: `guard_mismatch`,
`block_gone`, `anchor_conflict`, `find_not_found`, `find_ambiguous`; existing
`forbidden`, `validation`, `not_found`, `conflict` remain. Unexpected exceptions
remain masked. A guard mismatch must never trigger automatic force retry, and a
missing pending block must never be recreated by the tool.

The static `ArtifactsPort.update` must reject live document/deck ids with a
validation error naming `document_edit`/`deck_write`. The live adapter must reject
static `doc` ids with guidance naming “Make editable”. This requires authenticated
artifact lookup in L.7/service, not an extra unguarded read inside the tool.

Annotations are exactly READ_ONLY, WRITE_UPDATE, WRITE_CREATE, READ_ONLY in tool
order. Every mutation uses the existing registration dry-run gate, including
mark-answered and live `artifact_create`: it records the normal compact summary,
returns “Skipped in dry run: would …”, and never calls any mutation port.

Approval keys remain the existing platform connector convention:
`harbourmaster/document_edit`, `harbourmaster/document_comment`. The shared
approval resolver preserves these exact keys, and all four tools have
`PLATFORM_TOOL_LABELS` entries. No runtime-specific approval bypass is introduced.

## Validation evidence

- `bun install --frozen-lockfile`: passed (dependencies were absent initially).
- `bun run --cwd packages/mcp typecheck`: passed.
- `bun run --cwd packages/mcp test`: **387 passed, 0 failed** across 16 files.
- `bun run check`: passed, **9/9 tasks**, boundary lint clean. Initial run
  without `.env` failed on missing generated secret property types; the CI
  example environment resolved it without source changes.
- `bun run test`: passed, **9/9 package tasks**, plus **284 script tests**.
- `bun run build`: passed, **2/2 tasks**; normal existing bundle/sourcemap
  warnings only. `check-dev-only`: 193 server files checked.
- Client-bundle `rg -l 'drizzle' apps/web/dist/client`: no matches.
- `git diff --check`: passed.

Tests cover block guard and find schemas, pending/move/set/table inputs,
comment/reply/answered constraints, exact tool names and annotations, read-only
filtering, historical/delta/block read forwarding and text, guest/detached thread
preservation, edit status/history/skipped forwarding, all live mutation dry-run
paths, live and backwards-compatible static artifact creation, expected error
codes/guidance, static/live refusal forwarding and platform approval keys/labels.

No existing environment file/value was overwritten: this worktree had no `apps/web/.env`, so
validation temporarily used `.env.example` as documented by CI and removed that
temporary file afterward. No new checkout, delegate, push, PR or deployment.

L.7 integration remains intentionally outside this task: the real app adapter
round trip depends on L.2/L.4 and is not claimed by these mock-port tests.

## Independent review — 2026-10-27

Verdict: **changes requested** for one L.5 contract discrepancy. Reviewed `e24a7c51cfb729967a1777477a25e96dbecdf46c` on branch `t3/3d3e1c4c`, against the task, PRD and existing callers. No product or task files changed.

### P2 — Missing-find error does not match the PRD

`packages/mcp/src/result.ts:26` and `packages/mcp/src/tools/live.test.ts:341` expose and test `find_not_found`, while `docs/v3/live-artifacts-prd.md:500` specifies `find_none`. An adapter following the exported `ToolErrorCode` cannot return the specified code without changing the contract, and consumers using the PRD name will not recognize the emitted result. Align the exported code, tests and adapter guidance with `find_none`, or explicitly amend the PRD if the alternate name is intentional.

### Evidence and integration gates

The four schemas use strict objects; guarded block-id replace/delete require both hash and revision, and find targets are exact. Descriptions cover person-wins, pending blocks and detached comments. Annotations, tool labels, shared approval keys and conditional registration are present; read-only filtering and the shared dry-run gate cover the mutations, including document creation. Existing static artifact callers retain their port and validation behavior; `live` is optional. The package MCP suite passed: **387 tests, 0 failures**. Initial run before locked dependency installation failed on missing modules; the rerun passed.

`packages/mcp/src/tools/live.ts:284` delegates authorization, guards, atomic application and anchoring to the service; `:325` and `:340` describe anchor protection and agent-addressed answered state. These are contracts, not proof of enforcement. L.7 must bind principal, workspace, agent, run and tool-call identity and test actual permissions: created/handed or in-artifact edits, guest scope/role, protection of comment anchors including the agent's own, and answered updates only for the addressed agent. It must also implement static/live refusal guidance, error mapping and real room round trips. `apps/web/src/server/mcp/ports.ts:312` currently supplies static artifact ports but no live port, so production runtime registration and R1.22/R1.28 approval behavior across Pi, Managed Agents and machines remain integration gates, not demonstrated behavior or L.5 authorization defects. Mock-port tests cannot establish these properties.
