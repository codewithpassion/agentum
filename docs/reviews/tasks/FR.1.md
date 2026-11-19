# FR.1 review: Agent templates

## Verdict

Round 1, commit 51209e35: clean, nothing must-fix. Zero fix rounds.

The builder tests (78), `bun run check` and `bun run build` passed. The full `bun run test` passed for every TypeScript package. One web test, `guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions`, failed under full-suite load and passed alone, as on main before. The reviewer's run also hit a Rust test that needs a short checkout path for its D-Bus socket. FR.1 touches no Rust.

## What was built

- Eight templates in `packages/services/src/agent-builder/templates.ts`: inbox_triage, meeting_follow_up, lead_research, invoice_filing, weekly_report, support_first_reply, drive_tidy, social_drafts. Each has a title, description, voice, suggested apps by catalogue key, a job sentence, a remember list and an ask level. `AGENT_TEMPLATE_IDS` in `packages/db/src/shared.ts` lists the new ids. The old three ids went, because nothing persists them.
- `fromTemplate(principal, key)` on the builder service returns `{ didList, draft, gaps }` with no model call. The draft carries the name, description and voice. Apps map to connectors only through an optional `catalogKey` on the builder catalogue, which nothing fills yet. A suggested app with no connector adds a note and never a gap, so create is never blocked. The runtime stays null, so the usual "Where it runs" gap shows.
- The job sentence, remember list, ask level and unconnected apps reach the review screen as extra `didList` lines, because `AgentDraft` has no field for them and the review screen stays as it is.
- A tRPC mutation in `agent-builder-router.ts`, thin, input schema plus one service call.

## Nits left

- `fromTemplate` has no web caller yet. The chips on `/agents/new` still run the model draft. FR.4 wires the gallery to it.
- `didList` shows raw catalogue keys ("the google-calendar app") and a stuttering ask line ("Asks: Ask before it acts outside"). Display names and a better line come with KY.4.
- The ask labels exist three times (`templates.ts`, `ask-groups.ts`, the test).
- Two connectors with the same `catalogKey` both become tools.
- `lead_research` and `social_drafts` suggest `linkedin`, which may never be a catalogue entry.
- An unknown key at the service throws a `ZodError`, not a `ServiceError`. The tRPC input schema catches it first.
- The "creates an active agent" test uses the recording fakes with a cloud runtime, because the draft schema excludes the runtime "fake". No test creates an agent with template tools.
- One test name mentions validating a key, which `fromTemplate` never resolves.

## Beyond the scope

- Apply the template's ask level at create (`requests.setAskLevel`), its job sentence as a routine or job (JB), and its remember list as notes (ME). Today these are suggestions only.
- Align the template app keys with the KY.4 catalogue entries and fill `catalogKey` in `catalog()` once connectors carry one.

## Steps for Dom

None.
