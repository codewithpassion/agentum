---
id: SK.2
title: Runtimes read skills from the central store
milestone: SK
size: M
status: in_progress
depends_on: [SK.1]
branch: task/SK.2-skill-runtimes
---

Asked for by Dom on 17 Oct 2026. After SK.1, skills live in the store, but every runtime still reads the library's `skills/` folders: machines (daemon sync, task S.1, through `apps/web/src/server/routes/skills.ts` and `routes/runtime.ts`), Managed Agents (`packages/services/src/managed/skills-sync.ts`, M8.3), Cloudflare Pi runs (`apps/web/src/server/pi-run-skills.ts`, `skill-scripts/run-skill-script.ts`, C.12) and the Linux VM (`apps/web/src/server/linux-vm/vm-workdir.ts`, `vm-skill-sandbox.ts`).

## Scope

- Every runtime gets its agent's skills from `forAgent` in the SK.1 service: same file layout as today (`<name>/SKILL.md`, `scripts/` and other files), so skill scripts keep working. Executable flags are kept where the runtime has a filesystem.
- Managed Agents: upload each skill version once to the Anthropic Skills API and reuse it by version, keyed on the Harbourmaster skill id and version number, so a pin maps to that version and latest maps to the latest approved one.
- Machines: the daemon's sync keeps working with no daemon change if possible; if the wire format must change, keep the old format working for one release and say so in the review file.
- Stop reading the library's `skills/` folders anywhere. Library writes under `skills/` are no longer checked as skills (remove that special case in `library.ts`), and the library tool descriptions stop mentioning skills.
- A run may read its own proposed version by number (SK.1 rule) only through the SK.3 tools, not by default in its skill set.

## Check

- Tests per runtime adapter: skills come from the store, a pinned version is used over latest, a proposed version is never in the default set.
- Live on staging (controller): one skill with a `scripts/` TypeScript file runs on a Cloudflare agent and a Managed Agent as in C.12 and M8.3, after a new approved version replaced the migrated one.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request.
- 2026-10-18: dispatched. Note from SK.1: the service is `@repo/services/skills-store` (see packages/services/README.md and docs/reviews/tasks/SK.1.md); skill names are unique per owner scope, so show the owner wherever a name is shown.
