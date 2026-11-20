# FR.3 review: First run, add your AI account on the home page

## Verdict

Round 1, commit d89ee918: clean, nothing must-fix. Zero fix rounds.

Checks: `bun run check` and `bun run build` pass, and the bundle grep finds no drizzle in the client. `bun run test` passes everything except `guest-execution.test.ts` in apps/web, the known host flake that fails on `main` too. One earlier full run also failed `proxy.test.ts` "a lease holder that dies leaves a lease that expires in 30 s" under load. It passed alone three times and in the next full run. The reviewer also hit a Rust test, `the_session_bus_listens_where_the_environment_says`, which fails because the worktree path is too long for a D-Bus socket. It does not come from this task.

Browser proof: `docs/reviews/tasks/FR.3/browser.md`, pass at 1280x800 and 390x844. The first verifier run was blocked because the server checks a key live with Anthropic and rejected a made-up one. The re-run used the dev key from `apps/web/.env.local` and passed every flow.

## What was built

- An empty Home (no agents) shows a two-step guide in `components/roster/first-run-guide.tsx`, passed to `RosterWall` as `emptyState`. It replaces the "No agents yet" line and the dashed add cards.
- Step 1 embeds the Anthropic `ProviderKeyForm` with a one-line explanation. A saved Anthropic or OpenRouter key turns it into a Done row with a Manage keys link. The Home loader reads `managedKeys.status` and `modelKeys.status` for this, and saving a key refreshes the poll.
- Step 2 has the template gallery and a description box with "Continue to the builder". The box keeps its text in session storage under the builder's own key, so adding the key does not lose it and the builder shows it. Continue waits for a key, since drafting needs one. Templates work without a key.
- `/agents/new` takes a `template` search param and loads that template once, as a card click does.
- The setup rows are gone from the rail: `RailView.setup`, `RailSetupStep`, `SetupRow`, `SetupPane`, the setup logic in `pane-logic.ts`, and the rail service's key dependencies (and the two arguments in `compose.ts`). `packages/db/src/shared.ts` lost the type and the field, so the merge may touch a contract file.

## Nits left

- `docs/ux-review/rail/spec.md` (lines 92, 98, 182, 208) still describes the setup steps.
- The Home poll reads both key statuses every 10 seconds for good, even once agents exist.
- `ProviderKeyForm` renders its own heading under the step heading, so the step shows two headings and a doubled title.
- `noRemove` in the guide is a stub that cannot run.
- A template picked on Home replaces a description typed there, as a click in the builder does.
- `?template=` stays in the URL, so a reload loads the template again and drops edits made in the review screen.
- `Selection` keeps a `kind: "item"` field that no longer tells anything apart.
- No test covers the `template` param or the Home loader's key check.
- Browser proof: the Clerk dev-login redemption logged one 400 in the first run, outside this feature. A separate fresh login saw none.

## Beyond the scope

- Pass a draft request through from Home so the builder runs it on arrival, saving the second click.
- Clear `?template=` from the URL once the template has loaded.
- Starter credit stays out of scope, a billing decision for Dom.

## Steps for Dom

None.
