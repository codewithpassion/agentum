---
name: rename-project
description: Rename this monorepo and everything that carries its name - workspace name, bun.lock, the Cloudflare Worker in wrangler.jsonc, .cta.json, README headings, and the browser tab title. Use when the user says "rename this project to X", "call this project X", or is turning the boilerplate into a real named app.
allowed-tools: Bash(bun .claude/skills/rename-project/rename.ts:*), Bash(git:*), Read, Edit
---

# Rename the project

Run the script with the new name. It derives the current name from the root
`package.json`, so nothing else needs to be passed in.

```bash
bun .claude/skills/rename-project/rename.ts <new-name>
```

The name must be a valid Cloudflare Worker name: lowercase letters, digits and
hyphens. The script also derives a display name from it (`my-app` -> `My App`)
for the README headings and the tab title.

## What it touches

| Target | Field |
| --- | --- |
| `package.json` | `name` |
| `bun.lock` | root workspace `name` (first match only, so a like-named dependency is safe) |
| `apps/*/wrangler.jsonc` | `name` (the deployed Worker) and `database_name` (the D1 database) |
| `apps/*/.cta.json` | `projectName` |
| `README.md`, `apps/*/README.md` | first `# ` heading |
| `apps/*/src/routes/__root.tsx` | `title` in the document head |

`apps/web/package.json` stays `"name": "web"` on purpose. That is the workspace
path identity `turbo --filter=web` resolves, not the project name. Likewise
`packages/db` stays `@repo/db`: the `@repo` scope is deliberately not the
project name.

Renaming `database_name` does not rename anything on Cloudflare. Locally it
costs nothing: the next `bun run dev` applies the migrations to an empty
database under the new name. If a real D1 database was already created, tell the
user to run `wrangler d1 create <new-name>`, put the new id in `database_id` and
apply the migrations again with `--remote`. The old database and its rows stay
where they are.

## After it runs

Read the output. Two parts need your judgement.

- **`unchanged` lines.** A target that did not move. Either the regex missed it
  or it already said the right thing. Usually fine, but open it if unsure.
- **The "still mentions the old name" list.** The script deliberately leaves
  prose alone, because a word like `boilerplate` shows up in sentences
  ("without creating API boilerplate") where rewriting it produces nonsense.
  Decide per line, and edit the ones that are genuinely the project name.

The script finishes with `bun install --frozen-lockfile` to prove the lockfile
still matches `package.json`. If that fails, the lockfile name did not get
rewritten.

Renaming the Worker means the next `bun run deploy` creates a **new** Worker
rather than updating the old one. If the old name was ever deployed, tell the
user to delete that Worker and re-point any custom domain. Do not do it for
them.

Then commit, naming both the old and new name in the subject.
