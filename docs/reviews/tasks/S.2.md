# S.2 review

## Verdicts

Round 0, commit 27eccd4: clean. No must-fix findings, so there were no fix rounds.

## Decisions

- The frontmatter check lives in the library service (`library/skill-file.ts`), called from `write` and from the copy step of `move`. The tRPC editor, the F.2 `bash` tool and any other writer all pass through it. A bad SKILL.md is refused with the reason, which the editor shows.
- The check applies to `skills/<owner>/<skill>/SKILL.md` for any owner, not only agent ids and `_shared`. The description limit is at most 1,024 characters.
- The `bash` adapter skips the empty `writeFile` that a shell redirect makes before the real write (`cat > SKILL.md <<EOF` calls `writeFile(f, "")` and then `writeFile(f, text)`). Without that skip the service would refuse the empty open and no agent could create a skill with a redirect. As a side effect, a refused rewrite leaves an existing valid skill unchanged.
- `skills.catalog` and `skills.create` take the agent id and call `agents.get` first, so another workspace's agent is not found. `create` writes a short template and refuses an existing folder.
- The Skills tab reuses `LibraryFilePanel` unchanged, so it also offers Download and Delete on SKILL.md.
- Merged main after F.2 landed. The conflict was in `compose.ts` (both sides added a service) and the end of `library.test.ts` (both sides added tests).

## Checks

`bun run check && bun run test && bun run build` pass, and `drizzle` is absent from `apps/web/dist/client`.

Live on `vite dev` (port 3482) with the compiled daemon under a separate HOME: on a new Haiku agent, "New skill" with the name `shout` created the template and opened the editor. Saving it without a description showed "Frontmatter needs a description". Saving "when asked to shout, answer in capitals" saved, and the list showed the description. The run "shout hello" logged `skills synced: 1 files` and replied "HELLO".

The `bash` path is covered by `library-bash/skills.test.ts`: a valid skill written with a heredoc and edited with `sed -i`, one without a description, one whose name differs from its folder, and a `sed -i` that breaks a saved skill, all through the real library service.

## Nits left

- `skill-file.ts`: the description length counts UTF-16 units, so 600 emoji read as 1,200 characters.
- `library.ts` `copyRows`: a folder move checks each SKILL.md in the copy loop, so files that sort before it (`README.md`) are already copied when it is refused and leave orphan blobs. Checking all skill files before the first `put` would fix it.
- A skill folder cannot be renamed in place: changing the name first fails the folder match, and moving first fails the name match. Create the new folder and delete the old one. The UI has no rename.
- The adapter skips every empty write to a SKILL.md, so `touch SKILL.md` and `: > SKILL.md` exit 0 and write nothing.
- The frontmatter parser is looser than YAML (`description: Use when: asked` passes, a `- a` list reads as text, the first of two duplicate keys wins). Claude Code's own loader parses the file at run time, so a file that saves here could still fail there. Not confirmed.
- Only `skills.create` enforces the lowercase slug name rule. A script can write `skills/a1/My_Skill/SKILL.md` with `name: My_Skill`.
- `create` checks the folder is free and then writes without `ifEtag`, so two creates at the same moment both succeed and the second overwrites the first.
- No router-level test saves a bad SKILL.md through `library.write` and expects BAD_REQUEST. The service test covers the call the router makes.
- The agent page does not key tab panels on the agent, so switching agents keeps the Skills tab's open file and name field until the reload lands.
- `sed -i` reports every refused write as "No such file or directory", so the reason is lost on that command. A redirect, `cp` or `mv` shows the reason.
- `docs/tasks/S.2-skills-editing.md` says "under 1,024 characters". The code allows 1,024.

## Ideas beyond the scope

- A Delete on a whole skill folder and a rename in the Skills tab.
- Show a shared skill that an agent's own skill of the same name hides.
- Run a YAML parser in the check if Claude Code's loader turns out to be stricter.

## Steps for Dom

None.
