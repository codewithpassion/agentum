# SK.4 review

Skills page, versions, approvals and assignment in agent config.

## Verdicts

| Round | Commit | Verdict |
| --- | --- | --- |
| 1 | bf612aa | must-fix: a file added in the editor opened as not editable, `readFile` was not thin and over-fetched, Approve worked before the review diff loaded, Restore was offered on proposed versions |
| 2 | 30add97 | clean |

Fix round 1 set the editor's draft ref during render, moved the one-file read into the service (`readFile`), kept Approve disabled until the diff loaded, and hid Restore on proposed versions. It also passed `includeArchived` on the Skills page, keyed the history on the skill, and deferred `revokeObjectURL`.

## Decisions the task left open

- The new router is `skillStore` (`skill-store-router.ts`), next to the legacy `skills` router, which stays until SK.2 removes `skills.ts`. The old `skills.*` procedures now have no UI caller.
- Two additive service methods: `assignments()` (every assignment, for "assigned to" on the Skills page) and `proposals()` (versions waiting for a decision), plus `readFile({ skillId, version, path })`. Nothing else in the skills store changed.
- The Files tab edits the newest version that is not rejected and stages edits in a local draft, saved by one commit with a message. When that version is a pending proposal, a banner says a commit builds on it.
- The U.6 file panel is reused through its `io`. `LibraryFilePanel` got two optional additions: `labels` for the save button and `downloadHref` may be left out.
- `skill-files-panel.tsx` (the old per-file-save panel) is deleted, since the agent tab no longer creates or edits skills. Creating, uploading and editing happen on the Skills page.
- A person author shows as "A person" and an agent author as "agent name, run <last 8 of the run id>". Resolving user names is not in scope.

## Nits left

- A person committing on top of a pending proposal builds an approved version that carries the agent's unreviewed files. This follows SK.1's rules. Basing the editor on the latest approved version needs a decision.
- A version made after every earlier one was rejected has no parent, so its review panel lists files instead of a diff.
- Restore on the latest approved version makes a version with no changes.
- Uploaded files are staged as base64 even when they are text, so they cannot be viewed before the commit. An upload over an existing path replaces it without a warning.
- After a CONFLICT on commit the draft stays on the old base, with no rebase help.
- The agent Skills tab asks for each skill's versions one by one, and a slower reload can overwrite a newer one. Unassign has no confirmation.
- A description with a colon or `#` can break the new skill's frontmatter. The service refuses it with its message.
- Invalid base64 in `commit`, `create` or `importArchive` is a 500, not BAD_REQUEST.
- No component tests for the editor and history fixes. The repo has no component test setup.
- `skills.$skillId` loads the whole skill list to find one skill.

## Ideas beyond the scope

- Resolve user ids to names for authors and approvers, and link a run id to its session.
- A "rebase my draft" step after a stale commit.
- Reject the descendants of a stale proposal with one click from the review panel, and an approve-in-order helper (also noted in SK.1).
- Delete the legacy `skills` router and its tests with SK.2.

## Steps for Dom

None. The browser pass ran against a local dev server with dev login: upload of a `.skill` file, two files edited and committed once (version 2), the diff between versions 1 and 2, restore of version 1 (version 3), assigning the skill to a second agent and pinning version 2, and approving an agent's proposed versions (a new skill and a second version with a diff against its base).
