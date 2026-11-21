# FR.6 review: team starters in the New team dialog

## Verdict

Round 1 at 49be8ba6: clean, nothing must-fix. `bun run check` and `bunx turbo run test build --only --filter="[origin/main...HEAD]"` pass.

## What changed

- `teamFromStarter` sets every member's `runsOn` to the Cloud runtime when the workspace catalog lists it, and to null otherwise. No "workspace default runtime" existed in the code: a template draft has `runsOn: null` and the person picks. Cloud is listed whenever there is an Anthropic or OpenRouter key and needs no machine, so it is the closest default.
- The New team dialog shows Sales and Back office above the blank form. Picking one loads the `teamFromStarter` draft (name, lead, members, rules). Create calls `agentBuilder.createTeam` once and opens the team.
- With no runtime the review says so, disables Create and links to Settings, model providers.

## Browser steps skipped

The task's check has no browser step. The dispatcher also skipped any browser walk of the dialog, as instructed. The controller's end-of-v4 pass should open New team on /teams, pick each starter, and Create.

## Nits left

- The Settings link in the review is a plain `<a>`, so it reloads the page. A TanStack `<Link>` needs a router in the component test, and a router mock leaked into other test files.
- A workspace with only a machine and no key gets no default runtime and the "add an API key" message. Agent Create has the same limit.
- The test's fake loader returns a Sales draft whatever starter is picked, and `new-team-button.tsx` wiring is covered only by types.
- Starter titles and one-liners are repeated on the client. A test keeps the keys in step with the service.
- "Lead:" assumes the lead is the first member, as the service does.

## Ideas beyond the scope

- A real workspace-level default runtime (a setting) that templates, starters and agent Create all read.
- Offer a connected machine as the starter runtime.

## Steps for Dom

None.
