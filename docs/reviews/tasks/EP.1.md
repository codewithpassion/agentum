# EP.1 review

Implemented by Codex (gpt-6.1-sol), reviewed by Claude Opus.

## Round 1 (86ed1f2b): must-fix
- Needs you parsed only tool, host and secret grants, so a version with endpoint or agent grants could not be approved. Fixed in 033f6081.
- Taken with the fix: an index on `triggers.artifact_id`, a unique (artifact_id, agent_id), and the trigger kind `app` for tokenless app-owned triggers.

## Round 2 (033f6081): clean

## Nits left for later tasks
- EP.3: reuse a revoked app trigger when its agent grant is approved again (the unique index covers revoked rows), and never set `proposedByAgentId` on an `app` trigger (Needs you and MCP `statusOf` would treat it as a proposal). Check the agent belongs to the artifact's workspace before making the trigger. The app-trigger test should seed a row with `proposedByAgentId` set and cover reject.
- EP.2: the agent grant card shows the raw agent id and lacks the endpoint warning sentence.
- EP.4: MCP `TriggerInfo` has no `kind`, so an agent can't tell an app trigger from an http one.
- `guest-execution.test.ts` timed out once under the full parallel run and passes alone. Unrelated.
