---
id: SK.3
title: MCP tools to manage, version and assign skills
milestone: SK
size: M
status: done
depends_on: [SK.1]
branch: task/SK.3-skill-mcp-tools
---

Asked for by Dom on 17 Oct 2026. The Harbourmaster MCP server (`packages/mcp/src/tools/`, ports in `apps/web/src/server/mcp/ports.ts`) serves both people (OAuth clients and API keys) and agents' runs. R.1 added routine and trigger tools the same way; follow its pattern.

## Scope

- Tools over the SK.1 service, each a thin call so the service's rules apply:
  - `list_skills` (with owner, latest approved version, pending proposals, and which agents have it), `skill_log`, `skill_show` (tree, and one file's content by path), `skill_diff`.
  - `create_skill` and `commit_skill` (base version, several file writes and deletes, one message), `revert_skill`.
  - `import_skill` (a `.skill` archive as base64) and `export_skill` (returns the archive as base64, or as a Harbourmaster file link when that path exists and is simpler).
  - `approve_skill_version`, `reject_skill_version`, `assign_skill`, `unassign_skill`, `pin_skill`: people only, refused for runs by the service.
- Results for a run's commit say the version is proposed and waits for approval, and how to test it (read and run it by version number).
- An agent can run a script from its own proposed version: extend the existing skill-script tool for Cloudflare and VM runs (C.12, C.14) with an optional version, allowed only for the proposing agent's own proposed versions or any version of a skill assigned to it.
- Read-only connected apps get only the read tools (as in R.1).
- Tool descriptions explain the commit model in one or two sentences: a commit is a whole set of file changes on top of a base version, and a stale base is refused.

## Check

- Tool tests: a person creates, commits, approves, assigns and pins; a run creates and commits, gets "proposed", runs its proposed script version, and is refused approve, assign and commits to a skill it doesn't own; a stale base is refused; import and export round trip; a read-only client sees only read tools.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request.
- 2026-10-18: dispatched. Note from SK.1: the service is `@repo/services/skills-store` (see packages/services/README.md and docs/reviews/tasks/SK.1.md); skill names are unique per owner scope, so show the owner wherever a name is shown.
- 2026-10-18: review clean after 0 fix rounds at 54172d0 (docs/reviews/tasks/SK.3.md). Merged.
