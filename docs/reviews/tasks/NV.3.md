# NV.3 review: every conversation has a readable title

## Verdicts

- Round 1 (945347c8, Codex): must-fix, three items. Cut-off JSON from the TH.1 backfill showed as a title; rename stored markup the read path then hid; the task receipt's first step lost its full text through the new `runTitleText`.
- Round 2 (b9da008f, fixes): must-fix, one item. Rename still stored a marker or markup inside an otherwise readable title.
- Round 3 (46bbfc62, fixes): clean.

## Decisions taken from the spec

- A routine session is titled by its prompt's first line, not by the routine's name (the spec says so). An http trigger keeps its trigger name when that name is readable. `app` and `mail` triggers no longer show their trigger name; they use the first message.
- 80 characters includes the trailing `...`.
- A stored `sessions.title` that is not readable is ignored at read time, so old rows look right before the script runs.
- Rename rejects JSON, markup and attachment markers anywhere in the title.

## Nits left

- A title such as `Use List<String> here` or `Press <ctrl>` is rejected as markup on rename, and a derived title that starts with a tag falls back to "Conversation with <agent>".
- Prose like `[[Roadmap]] update please` or `{"quoted"} is my word` reads as JSON-like and gets the fallback title.
- Cut-off numeric or single-quoted JSON (`[1, 2, 3, 4`) still shows.
- A multi-line rename is stored as typed; only derived titles are cut to one line.
- Renames made before this change that hold a marker or markup mid-title still show, and the retitle script does not repair them.
- The retitle script parses wrangler's JSON from the first `[` in stdout.
- Desk cards now cut titles at 80 characters in effect, below their 120 limit, and say "Conversation" where they said "Task" for empty input.

## Ideas beyond the scope

- Store a derived title on the session when its first run starts, so lists need no read-time derivation.
- Give the retitle script a mode that also repairs mid-title markers in renamed rows.

## Steps for Dom

- Run the repair against production when ready: `cd apps/web && bun run retitle-sessions --remote` for the dry run, then add `--apply`. Do the same with `--env staging` first if staging holds data.
- Unrelated and already failing on main in this environment: `guest-execution.test.ts` (workerd socket closes) in apps/web, and a Rust D-Bus test in `agentum-rs`.
