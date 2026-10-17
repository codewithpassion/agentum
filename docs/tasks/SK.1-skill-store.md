---
id: SK.1
title: Central versioned skill store with commits, assignments and .skill import
milestone: SK
size: L
status: todo
depends_on: [R.1]
branch: task/SK.1-skill-store
---

Asked for by Dom on 17 Oct 2026. Skills today are folders in the workspace library (`skills/<agentId>/`, `skills/_shared/`), read by `packages/services/src/skills.ts` with checks in `packages/services/src/library/skill-file.ts`. Dom wants them managed centrally, like Anthropic Managed Agents: versioned with a git-like interface, assignable to any agent, importable from Claude's `.skill` files. Decisions (Dom, 17 Oct): an agent's commit is approve-first; an assignment follows the latest approved version unless pinned; storage is a git-like API on D1 plus R2, not real git; existing library skills are migrated, then the library's `skills/` is no longer read.

This task builds the store and its service. Runtimes (SK.2), MCP tools (SK.3) and UI (SK.4) build on it, so the service API is the contract: keep it small, documented in `packages/services/README.md`, and stable.

## Scope

1. Data (`packages/db`, migration via `bun run generate`):
   - `skills`: workspace, name (unique per workspace, same name rules as today's SKILL.md `name`), owner agent (nullable: null means owned by people), created by, timestamps, deleted flag.
   - `skill_versions`: skill, number (1, 2, ... per skill), parent version, message, author principal (user id or agent id plus run id), status `approved` | `proposed` | `rejected`, approved by and at, timestamps. A version holds the full file tree, not a delta.
   - `skill_version_files`: version, path, content hash, size, executable flag.
   - `skill_assignments`: agent, skill, pinned version (null means latest approved).
   - File contents go in R2 under `skill-blobs/<sha256>`, written once, shared across versions and skills.
2. Service `@repo/services/skills-store` (replace or extend `skills.ts`, keeping one service for skills):
   - `create` (name plus initial files plus message), `commit` (skill, base version, list of `{path, content}` writes and `{path}` deletes, message): one commit makes one new version from the base's tree. A stale base (not the latest version, approved or proposed) is refused with a conflict error, like a git non-fast-forward.
   - `log`, `show` (a version's tree, file contents on request), `diff` (two versions: added, removed, changed paths, and a unified text diff for text files), `revert` (a new version whose tree equals an older one).
   - `approve` and `reject` for a proposed version (people only). Approving a version whose base is no longer the latest approved is refused, so a stale proposal must be redone.
   - `assign`, `unassign`, `pin` (version or null) per agent, and `forAgent(agentId)`: the agent's resolved skills, each at its pinned version or latest approved, as a list of files.
   - `importSkillArchive(zip bytes)` and `exportSkillArchive(skill, version)`: a `.skill` file is a zip holding one top-level folder with `SKILL.md` and any other files (`scripts/`, `references/`, `assets/`). Use `fflate`, pinned exactly. Import makes a new skill, or a new version of an existing skill with the same name.
   - Every write validates with today's SKILL.md checks and the existing size and file-count limits (`SKILLS_MAX_BYTES`, `SKILLS_MAX_FILES`), and rejects unsafe paths (absolute, `..`, backslashes, empty segments) and zip bombs (cap the total unpacked size before inflating everything).
3. Rules, enforced in the service through `authorize()`:
   - A user principal with workspace access: everything. Their commits and imports are `approved` at once.
   - A run principal: may create skills (owned by its agent), commit to skills its agent owns, and read the skills assigned to its agent. Its versions are `proposed`. It may not approve, reject, assign, unassign or pin, and may not commit to skills it doesn't own.
   - The proposing agent can read and run its own proposed versions by number, so it can test a change before approval. Assignments resolve only to approved versions.
4. Events for create, commit (proposed or approved), approve, reject, revert, assign, unassign, pin, import, naming the principal and the version, never file contents.
5. Migration, as a one-off service method run on first access per workspace (idempotent, recorded so it runs once): each `skills/<agentId>/<name>/` folder becomes a skill owned by that agent, version 1 approved, assigned to it. Each `skills/_shared/<name>/` folder becomes a people-owned skill, version 1 approved, assigned to every agent of the workspace. An own skill with the same name as a shared one keeps today's behaviour: the agent gets its own and not the shared one. The library files stay where they are; SK.2 stops reading them.

## Check

- Service tests with `bun:sqlite` and an in-memory blob store: create, multi-file commit, stale-base conflict, log, show, diff, revert; run commit is proposed and unassigned agents can't read it; the proposer reads its proposed version; approve and reject, stale approve refused; assign with and without pin, `forAgent` resolving pinned and latest approved; `.skill` import and export round trip, including a `scripts/` file with the executable flag; unsafe paths and an oversized archive refused; run principal refused for approve, assign and foreign commits; migration with own, shared and same-name cases, and a second run that changes nothing; events written without contents.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request.
