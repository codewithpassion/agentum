# SK.3 review

MCP tools to manage, version and assign skills.

## Verdicts

| Round | Commit | Verdict |
| --- | --- | --- |
| 1 | 9b7d8fb | clean |

No fix rounds.

## Decisions the task left open

- Fourteen tools: `list_skills`, `skill_log`, `skill_show`, `skill_diff` and `export_skill` (read), and `create_skill`, `commit_skill`, `revert_skill`, `import_skill`, `approve_skill_version`, `reject_skill_version`, `assign_skill`, `unassign_skill` and `pin_skill`. A read-only key or connected app gets the five read tools. The people-only tools stay visible to runs and the service refuses them, as in R.1.
- `export_skill` returns base64 only. No Harbourmaster file link exists for it, so the "simpler path" in the task did not apply.
- File writes in `create_skill` and `commit_skill` carry an `encoding` (`utf8` by default, or `base64`) so binary files can be committed. `skill_show` with a path returns UTF-8 text, or base64 when the bytes are not valid UTF-8.
- `list_skills` finds "which agents have it" through `forAgent`, so a skill with no approved version shows no carriers. For a run, only its own agent is listed.
- `run_skill_script` gets an optional `version`, only when the extension is given a `versions` reader. `pi-run.ts` always gives one (`skillVersionFiles`, which reads through `skillsStore.show`), so the store decides what a run may read: approved versions and its own agent's proposals. With a reader the `skill` parameter is a plain string and the tool exists even when the catalog is empty, so a run can test a skill that has no approved version yet. The VM and isolate sandboxes are unchanged.
- The `guarded` helper moved from `ports.ts` to `mcp/guarded.ts` so the skill ports share it.

## Nits left

- `listSkills` costs one `forAgent` per agent and one `log` per skill, and `forAgent` loads each tree.
- `skillNameOf` runs the whole `skillsStore.list` to get one name, after most writes and reads.
- Every run now gets `run_skill_script`, even with no skills, and its `skill` parameter no longer lists the valid names.
- `skillVersionFiles` turns missing content into an empty file, while `fileContentAt` throws.
- The assign, unassign and pin texts show only the skill id, and the create, commit and approve texts show the name without the owner.
- The `skillId` and `version` schemas are defined in both `skills-read.ts` and `skills-write.ts`, with different caps.
- `export_skill` puts the archive in both the text and `structuredContent`, so the payload doubles.
- `skill_log` sorts newest first again, though the service already does.
- A test builds `deletes` through an odd `map`, one test checks only `isError`, and `list_skills` as a run has no test.
- A scripted version in the Linux VM is placed in the skill's folder on top of the approved files, so a file the proposed version dropped stays there until the next unversioned run refreshes the folder.

## Ideas beyond the scope

- A service method that lists the assignments of a skill (and of all skills), so `list_skills` and the UI need no `forAgent` per agent.
- A Harbourmaster file link for `export_skill`, so a large archive does not travel as base64.
- Put the owner in every skill text, not only in `list_skills`.

## Steps for Dom

None.
