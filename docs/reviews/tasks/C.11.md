# C.11 review

Task: Cloud agents use their instructions, clear unknown-model error. Branch task/C.11-cloud-instructions-model.

## Verdicts

- Round 1 (471a3b3): clean, 0 must-fix, 6 nits. No fix rounds.

## What changed

`PiPort` has a new `setInstructions`. `PiRun` implements it with `configure({ instructions })` on the root conversation, and pi-durable renders `instructions` as the last prompt section, after the files and skills sections. The run core calls it next to `setModel` when a run starts and when a run is submitted again after a wake. The instructions are stored with the run, so a resumed run keeps the ones it started with. An empty string clears the section. An edit applies from the next run because every start passes the agent's current instructions.

`cloudModelError` in `@repo/services/cloud/models` returns a message that names the model id and lists the valid cloud models, built from `CLOUD_MODELS`. The run core asks a new `modelError` dependency before it installs tools or saves the run. A bad model completes the run as failed with that message and never reaches Pi. It does not throw, because a throw from `start` releases the run and the sweep retries it for ever. In dev the `faux` model is accepted.

The agent form shows a select of the three cloud models when the runtime is cloud. A value that matches none shows "Choose a model" until one is picked.

## Checks

- `bun run check`, `bun run test` and `bun run build` pass. The bundle grep for `drizzle` in `apps/web/dist/client` finds nothing.
- New unit tests: the instructions reach the Pi session before the first submit, a changed instruction applies to the next run, a resumed run uses its stored instructions, an unknown model fails the run with the message and touches nothing in Pi, and `cloudModelError` for every alias and id, case, spaces and unknown values.
- Live on `vite dev` with local D1, workspace key from `.env.local` stored through Settings, Managed Agents: a cloud agent (Haiku) with the instructions "Always end your reply with the word harbour" ended its reply with `harbour`. After editing the instructions to say `pelican`, the next message in the same session ended with `pelican`. With the model set to `claude-nope-1` in the local database, the run failed with `Unknown model "claude-nope-1". Valid cloud models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5), haiku (claude-haiku-5-5).` The form listed only Opus, Sonnet and Haiku.

## Nits left

1. A run stored before this change has no `instructions` field. On resume, `setInstructions(undefined)` clears the section. Only matters for cloud runs already stored in a deployed object.
2. `instructions || null` sends whitespace-only instructions as a blank section. Trimming first would clear it.
3. The `cloudModelFor` comment still says an unknown id "fails at the API". Only `faux` reaches that fallback now.
4. In dev, a cloud agent on `faux` shows "Choose a model" in the form and cannot be saved until a real model is picked. Seeded agents still run.
5. The model is checked when a run starts. The agents service still accepts any model for a cloud agent over tRPC or MCP.
6. No unit test covers the `PiRun` wiring of `setInstructions` (the DO class has no bun test). The live check covers it.

## Ideas beyond the scope

- Validate the model when a cloud agent is saved, in the agents service, so a bad id fails at the form and over MCP, not at the first run.
- Share the model catalog between `cloud/models.ts` and `managed/config.ts` (C.6 nit 1).

## Steps for Dom

None.
