# A.1 review: artifacts contract

## Verdicts

Round 1 (5fd34e2): not clean, two must-fix. The `ui/message` params took one content object where the MCP Apps spec takes an array of content blocks, and `ui/initialize` params refused `appCapabilities`. Fixed in 79d11f4, with the `ui/notifications/initialized` notification added and the view `asn` output changed to a string to match its text column.

Round 2 (79d11f4, fix commits only): clean.

## Deviations from the task file

- The tRPC schemas live in `packages/protocol/src/artifacts.ts` with the rest of the protocol, one file. A separate file re-exported from it would be a barrel, which Biome forbids.
- `artifact_view_salts` has the composite primary key `(workspace_id, day)`, because every table carries `workspace_id`.
- `artifacts.current_version_id` has no foreign key, because `artifact_versions` points back at `artifacts`.
- Controller additions: table `artifact_pins`, column `artifacts.handed_to_agent_id`, `ARTIFACT_PIN_SURFACES`, and `agentCanUpdate` allowing the handed-to agent.
- `policy.ts` also exports `agentCanSee` (R1.6: a run sees workspace artifacts, the ones its agent made, and the ones handed to it). A.2 needs the rule.
- The manifest schema also enforces the file count, per-file and total size limits.

## Nits left

- `appInfo` and the text content block in the bridge schemas are strict objects. The MCP Apps `Implementation` and `TextContent` types allow extra optional fields (`title`, `icons`, `annotations`, `_meta`), so a page that sets them is rejected.
- No test rejects the old single-object `ui/message` content shape or an empty array.
- View token claims do not tie `viewer` to its ids (a `member` token may omit `userId`, a `link` token `shareId`). Verification callers should check.
- `signViewToken` does not cap `expiresAt`. R1.29 needs tokens minted for a link to live at most 1 hour, so the minting service (A.3) must set it.
- `verifyViewToken` with an empty key may throw from `importKey`. Callers pass a configured secret.
- Bridge storage keys and values, and `tools/call` results (text blocks only), have no size bounds or other block types.
- `artifactContentPath` does not validate its path argument. The parser refuses `..`.
- `artifactCardSchema.currentVersion` is a non-null number, but `current_version_id` is nullable (an app whose only version is `proposed`).
- `artifact.pin` has no `position` input and no reorder procedure, although the table has `position`.
- `artifact_versions.author_run_id` has no foreign key to `runs`. `artifact_versions.message` is NOT NULL, so A.2 writes `""` when none is given.
- `request.cf.asn` is a number, so the writer of view rows converts it to a string.
- `ArtifactPublishedPayload` sits at the end of `shared.ts`, not beside the other payload interfaces.
- `ArtifactFrame` props spell out the version and viewer types instead of importing `UiInitializeResult`.

## Ideas beyond the scope

- A discriminated union for view token claims by viewer kind.
- A shared `bridge` fixture module so A.4 (bridge script) and A.8 (frame side) test against the same messages.

## Steps for Dom

None. No account, dashboard or remote D1 step. The migration `0024_*.sql` applies with the usual `wrangler d1 migrations apply DB --remote` when the branch ships.
