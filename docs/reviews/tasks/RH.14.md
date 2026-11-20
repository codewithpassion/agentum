# RH.14 review: no tab imports from another tab's folder

## Verdicts

- Round 1 (ee2916a5): not clean, 1 must-fix. The new test missed an import of a tab folder by its bare name (`../settings`, `#/components/agent/room/knows`).
- Round 2 (1b16cd31, fix only): clean.

## What changed

- `canManageAgentKeys` and its six tests moved from `room/keys/keys-logic.*` to `components/agent/agent-rights.ts` and `agent-rights.test.ts`. The Keys tab (`index.tsx`, `apps-section.tsx`) and the Settings tab import it from there.
- `room/tab-imports.test.ts` scans every file under `room/<folder>/` and fails on an import into another folder under `room/`. It reads relative and `#/components/agent/room/` imports, `export ... from`, dynamic imports and bare folder imports. It failed on the parent commit with `settings/index.tsx imports ../keys/keys-logic.ts` and passes now.
- The test allows three folder pairs: `now>knows` (RH.5 log), and `chat>now` and `work>now`, because `now/` is a panel the Chat and Work tabs host (RH gate finding 12). The task text names only the first. The test also asserts that the edges it finds equal that set, so a scan that parses nothing cannot pass.

## Nits left

- The test does not see `mock.module("../keys/keys-logic", ...)` or an alias path that climbs with `..`. No file does either today.
- A bare `..` from a tab reports an edge to an empty folder name. It would not compile anyway.
- Removing an allowed import on purpose breaks the test, because the edge set must match exactly. The failure shows both sets.
- `agent-rights.ts` keeps the name `canManageAgentKeys` and a doc comment that lists only Keys uses. It also gates the owner and backup selects in Settings. Renaming is outside this task.

## Beyond scope

- `now/learned-slot.tsx` still imports from `knows/` (gate finding 12). Moving `LearnedList`, `learnedThisWeek` and `useMemory` out of `knows/` would let the allowed set drop `now>knows`.

## Steps for Dom

None.
