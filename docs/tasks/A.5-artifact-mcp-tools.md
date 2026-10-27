---
id: A.5
title: Artifact MCP tools
milestone: A
size: M
status: done
depends_on: [A.1]
branch: task/A.5-artifact-mcp-tools
lane: mcp
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- `packages/mcp/src/tools/artifacts.ts` with `artifact_create`, `artifact_update`, `artifact_read`, `artifact_list`, `artifact_test` (PRD section 2: inputs, outputs, annotations, limits, errors), registered like the wiki tools (`packages/mcp/src/tools/wiki.ts`) in `server.ts`, with ports in `packages/mcp/src/ports.ts` (`ArtifactsPort` with create, update, read, list, test). `artifact_test` returns text only: title, console errors and warnings, failed requests, snapshot text, screenshot library path.
- Descriptions tell agents to build in their task folder, use relative paths, keep data in `data.json` next to `index.html`, and run `artifact_test` before saying they are done.
- Dry-run text for the two write tools (R1.10). `PLATFORM_TOOL_LABELS` entries for `artifact_create` and `artifact_update` in `packages/services/src/agent-profile/ask-before.ts` (R1.11's profile side).
- Results never include a view or share token (R1.13).
- Leave a slot for phase 2's `artifact_promote` (B.4 adds it).

## Check
- Tool tests for schemas, annotations, the dry-run text and every error code (`validation`, `not_found`, `forbidden`, `conflict` with the current version in the message); `tools.test.ts` lists the new names.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 4d7dc89, review clean after 0 fix rounds; McpPorts.artifacts is optional, A.6 must wire it; merged.
