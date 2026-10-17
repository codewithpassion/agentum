# SK.2 review

Runtimes read skills from the central store.

## Verdicts

| Round | Commit | Verdict |
| --- | --- | --- |
| 1 | 5299da9 | must-fix: a file read resolved every assigned skill, the old run `list` and `read` still read the library, machines get no executable flag |
| 2 | e8a5e6c | clean |

Fix round 1 made a file read resolve only the skill named in its path (`forAgent` takes `paths`), and deleted the old service's run `list` and `read` with their tests. The executable flag for machines is a decision, below.

## What changed

- `@repo/services/run-skills` is the one reader for runs. `list` and `read` give `<name>/<file>` paths from `forAgent` (pinned version, else latest approved, never a proposed one) and check the 200 file and 5 MB caps over the whole set. Machines (`routes/skills.ts`), Cloudflare runs (`pi-run.ts`), the Linux VM (same port) and Managed Agents (`managed/skills-source.ts`) all use it.
- Linux VM: `SkillSummary.executable` carries the flagged paths and `placeSkills` runs one `chmod +x` for them.
- Managed Agents: new table `managed_skill_versions` (migration 0006), keyed on skill id and version number. A version is uploaded once and shared by every agent. Further versions of a skill go under the same Anthropic skill. A pin maps to that version, no pin to the latest approved. The old per-agent `managed_skills` rows are no longer written. Each agent's next launch deletes its old mirrors at Anthropic and the rows.
- The library no longer checks a SKILL.md under `skills/` (`checkSkillFile` and the empty-write special case in `library-fs.ts` are gone). No library tool description mentions skills, so none changed.
- A run reads its own proposed version only through the SK.3 tools. The default set never has one.

## Decisions

- Wire format for machines is unchanged, so no daemon change and no compatibility window. The list route still answers `{ etag, path, size }` (etag is the content hash). Machines therefore get no executable flag. In sudo mode the daemon writes files with `dd` as `hm-agent`, and a `chmod` there needs a new sudoers rule on every machine. Bun runs the scripts anyway. A later task can add an optional `executable` field the daemon asks for, plus the sudoers line.
- Managed Agents get no executable flag either: the Skills API upload has no file modes.
- `skills.ts` keeps the Skills tab half (`catalog`, `create`, `tree`, `readFile`, `writeFile`, `removeFile`) because the tab and `skills-router` still use it. SK.4 replaces them. It still reads the library, only for that tab. Tab writes are no longer validated as skills. Delete the file when SK.4 lands.
- `skillFileAt` in `library/skill-file.ts` has no production caller left. It stays because the old tab tests use it. Delete it with `skills.ts`.
- Migration 0006 may collide with another branch's migration number.

## Nits left

- `packages/services/src/skills.ts:2-5` header still describes run reads.
- `packages/db/src/schema/managed.ts:52` the sentence about racing launches is unclear.
- `packages/services/src/skills-store.ts` (~1361) the per-file `paths` check is now redundant after the per-skill filter, but it still limits files within a skill.
- A read still costs about five D1 queries (migration check, agent, assignments, version, tree) plus the blob, and a VM launch reads every file one by one. A set near the 200 file cap costs about 1,000 queries in one call. A bulk read per skill would fix it.
- Uploads at Anthropic are never deleted when a skill is deleted or unassigned everywhere. Only removing the workspace key clears the rows.
- Two launches racing to upload different first versions of a skill can create two Anthropic skills, and both rows are kept.
- The Cloudflare and VM adapter tests use fake ports. "Pinned over latest" and "proposed never listed" are tested at `run-skills`, the machine route and the managed source, not through the Durable Object.
- `docs/architecture/index.html` still says skills live in the library under `/skills/<agentId>/`.

## Ideas beyond the scope

- A bulk `readSkill(name)` on the skills port, used by `placeSkills` and `run_skill_script`, to cut the query count above.
- Drop `managed_skills` and its stale handling one release after this one.
- Garbage-collect Anthropic uploads of versions no agent carries.

## Steps for the controller

Live check on staging, after the merge and `wrangler d1 migrations apply DB --remote --env staging` (migration 0006):

1. In the workspace, approve a new version of a migrated skill that has a `scripts/` TypeScript file, assigned to a Cloudflare agent and to a Managed Agent.
2. Run the Cloudflare agent: it should activate the skill and `run_skill_script` the script, as in C.12.
3. Run the Managed Agent: it should list the skill, run the script with bun, as in M8.3. Check that `managed_skill_versions` has one row for the version and that the agent's old `managed_skills` row is gone.
4. Pin the old version on one agent and run it again: the older script output comes back and no new upload happens.

## Steps for Dom

None. Orphaned Anthropic skills titled `harbourmaster <agentId> <name>` are deleted by the next launch of each managed agent.
