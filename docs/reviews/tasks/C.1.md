# C.1 review

## Verdicts

- Round 1 (1ed0223): clean. The reviewer found no must-fix items. It re-ran check, test and build, the `drizzle` grep on `dist/client`, and the dry run, and got the same bundle size.

## Bundle size

`wrangler deploy --dry-run` on the built app: Worker total 4153.88 KiB across 89 modules. Total upload with assets 8590.05 KiB (1908.87 KiB gzip). The limit is 64 MiB. `--env staging` gives the same figures. `dist/server/index.js` grew from about 3.4 MiB (main) to 4.3 MiB. Worker startup under 1 s is for the controller to check after the staging deploy.

## Decisions

- The migration tag is `v3`, not the `v2` in the task file. M8.1 (task/M8.1-managed-agents) already uses `v2` for ManagedPoller. Main had only `v1` when C.1 merged main in.
- `@earendil-works/chord` 1.3.0 is a dev dependency, exact, because the test imports `BACKGROUND_CONTEXT` from it. It is the same version pi-durable depends on.
- The `agents` pin moves from ^0.24.0 to 0.28.1.
- `PiRun` opens `PiHarness` over its own storage with the Anthropic provider and an empty registry. No tools, credentials or run wiring yet.
- The shape test runs a real harness with a faux model. A tool returning `output` reaches the model. A tool returning `content` reaches it as empty text.

## Nits left

- Wrangler applies only migrations listed after the deployed tag. If C.1 deploys first and M8.1's `v2` lands between `v1` and `v3`, `v2` never runs. M8.1's merge must append `v2` after `v3`, or `v3` must be renamed `v2` if M8.1 merges first.
- `typebox` is pinned as asked but nothing imports it yet. The test takes `Type` from pi-ai.
- `agents` moved four minor versions, and `createMcpHandler` in `routes/mcp.ts` has no runtime test on 0.28.1.
- No test builds `PiRun` or touches the binding.

## Ideas beyond the scope

- The skills tools in `agents@0.28.1` still return `content`, so the model gets empty text from them. C.7 needs to wrap them, and the shape test is the reminder.
- A bun test that loads `PiRun` under the `cloudflare:workers` shim would catch import breakage before a deploy.

## Steps for Dom

None for Dom. The controller does these after merge:

- Deploy to staging, check Worker startup under 1 s and that `/mcp` still answers on `agents` 0.28.1.
- Write the `v3` decision into the task file. It still says `v2`.
- Merge order with M8.1, as in the first nit.

Controller note (17 Oct 2026): the PiRun migration tag was renamed to `v2` on main before any deploy. M8.1's ManagedPoller takes `v3`, appended after it.
