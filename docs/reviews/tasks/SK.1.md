# SK.1 review

Central versioned skill store with commits, assignments and .skill import.

## Verdicts

| Round | Commit | Verdict |
| --- | --- | --- |
| 1 | 55a5df0 | must-fix: a skill whose versions were all rejected could never be committed to again |
| 2 | af4c4c7 | must-fix: a cascaded reject wrote one event for several rejected versions |
| 3 | 8c66332 | clean |

Fix round 1 made the next commit on an all-rejected skill start from the newest version with no parent, made a reject also reject the proposals built on it, refused a commit that writes the same path twice, and derived the size message from the cap. Fix round 2 wrote one `skill.rejected` event per rejected version (with `rejectedWith` on the later ones) and refused a commit that deletes the same path twice.

## Decisions the task left open

- The service is a new module, `@repo/services/skills-store`. `skills.ts` is untouched because the runtimes, routes and tRPC still read it until SK.2. Only its name constants moved to `library/skill-file.ts`. SK.2 should delete `skills.ts`.
- Names are unique per owner scope (people's skills, or one agent's own), not per workspace. The task's migration needs an agent's own skill and a shared skill of the same name to coexist, which a workspace-wide unique name cannot hold. An agent carries at most one assigned skill per name.
- The file and byte caps apply to each version's tree. The total over an agent's assigned skills is for the loader (SK.2) to check.
- `skills.deleted` exists as asked but no delete method was in scope. Nothing lists a deleted skill.
- Library skills that break a rule (no SKILL.md, bad name, over the caps) are skipped by the migration and returned in `skipped`. The files stay in the library.
- `exportSkillArchive` returns `{ bytes, filename }`, and `importSkillArchive` returns `{ created, name, version }`.

## Nits left

- `decide` (approve and reject) does not check how many rows its update changed, so two racing decisions on one version can both write an event.
- Two concurrent `assign` calls of different skills with the same name can both succeed. No index covers it.
- The migration is one atomic batch per workspace with no size cap, and every method runs it on first access. A very large library could be slow on its first call, and a failure repeats on every call until it is fixed. Unverified against real D1.
- `storeBlobs` does an R2 head and then a put for each new blob.
- The unique indexes on `skills` ignore `deleted`, so a deleted skill still holds its name. Revisit when a delete method is added.
- `inArray` over a chain of more than about 98 proposals in one cascaded reject would pass D1's 100 parameter limit.
- The `commit` doc comment wraps at 106 characters, and the all-rejected test cannot tell a kept tree from a fresh one because v1 has one file.
- `compose` falls back to in-memory skill blobs when `skillBlobs` is not passed, the same as the library does. The real `compose` always passes R2.

## Ideas beyond the scope

- A delete (and restore) method for skills, then drop `deleted` from the name indexes.
- Reject descendants and approve-in-order helpers in the UI (SK.4), since a stale proposal must be redone.
- A cap on the total size of an agent's assigned skills, checked in `assign` or by the loader.
- Garbage collection of blobs no version points at.

## Steps for Dom

None. The migration `0005_colossal_millenium_guard.sql` is applied with `wrangler d1 migrations apply DB --remote` on the next deploy. The library skills move into the store on the first request to each workspace after that.
