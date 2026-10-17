# U.6 review

Task: Edit a skill's other files on the Skills tab. Branch task/U.6-skill-files.

## Verdicts

- Round 1 (22deac1): must-fix, 1 must-fix, 5 nits. `writeFile` applied the 200 file and 5 MB caps to one skill folder, but S.1 defines them for all of an agent's skills together.
- Round 2 (8c0840c): must-fix, 3 must-fix. The fix counted the editing agent's winning skills, but a write to a shared skill was checked for that agent only, and not at all when the agent hides the shared skill with its own skill of the same name.
- Round 3 (44675bc): clean, 0 must-fix, 4 nits. Two fix rounds.

## What changed

The Skills tab opens a skill as a file tree with an editor. The user adds a text file by path, edits any text file, uploads files (binary too, up to 10 MB each) and deletes a file. Uploads go to the skill root, or to a folder picked in the tree.

`packages/services/src/skills.ts` gets `tree`, `readFile`, `writeFile` and `removeFile`, each scoped to one skill folder of an agent or of `_shared`. Paths that are absolute, hold `..`, `.`, an empty segment, a backslash or a control character are refused before the library sees them. Writes still pass through `library.write`, so the 10 MB file cap, the 1 GB workspace cap and the SKILL.md frontmatter check apply. On top of that a write is refused when the agent's winning skills would pass 200 files or 5 MB. A write to a shared skill is checked for every agent in the workspace that does not hide that skill.

`skills-router.ts` exposes `files`, `readFile`, `writeFile` and `removeFile`. `LibraryFilePanel` takes an optional `io` prop so the skill editor reuses it, and `/library` is unchanged. `skill-tree.ts` holds the pure tree and path helpers.

## Checks

- Service and router tests cover add, edit, delete, a binary upload, `..` and absolute paths, the caps and cross-workspace refusal.
- Browser, dev login on a local dev server: created a skill, added `scripts/hello.ts`, edited and saved it, uploaded a 1x1 PNG, deleted the PNG, and the tree updated each time.
- `bun run check && bun run test && bun run build` pass.

## Nits left

1. `skills.ts` `writeFile`: a shared write walks the skill tree once per agent, all at once. Many agents with many files could press on subrequest limits.
2. `skills.ts` over-cap error does not say which agent overflows, so a shared write can fail on agent X's tab while X is under the cap.
3. `skills.ts`: archived agents count toward the shared check, so an archived agent near the cap blocks shared writes with no hint.
4. `skills.ts` `create` has no cap check (from S.2). An agent at 200 files goes to 201 when a skill is created.
5. `skills.ts` `removeFile`: deleting the last file of an own skill can bring a shared skill of the same name back, with no cap check.
6. `skill-files-panel.tsx`: the "10 MB" in the upload message is fixed text, while the limit comes from `LIBRARY_FILE_MAX_BYTES`.
7. `skill-files-panel.tsx` "Add file" checks the loaded tree, then writes with no `ifEtag`. A stale tree can overwrite an existing file with an empty one.
8. No test for the archived-agent case, or for both agents seeing a shared skill with the editing agent over the cap.

## Ideas beyond the scope

- Delete a whole skill from the tab (today only files, and empty folders stay in the library).
- Show an inline image or a download link for binary files in the tree.

## Steps for Dom

None.
