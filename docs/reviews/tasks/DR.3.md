# DR.3 review: dream inputs

Task: `collectSince` in `packages/services/src/dream/collect.ts` (with `collect-load.ts`). Implemented by Codex, reviewed by Opus.

## Verdicts

- Round 0 at `413534ae`: not clean, four must-fix. Mail replies that continue an existing session were tagged private. Text that reached a run through a peer's parent chain was ignored. Every dream read the agent's whole history. Dry-run sessions and runs counted as evidence.
- Fix round 1 at `d9c259dd`: not clean, one must-fix. Assistant messages of a mail-reply run were still tagged private, because messages were tagged by their own actor only.
- Fix round 2 at `06f26637`: clean.

## Decisions to know

- The service reads the tables directly, scoped by workspace and agent, because the session, memory and skill services reject the system principal (it has no workspace). It does not impersonate a person, which would hide private data.
- Only rows that changed after `since` are read, plus the runs, requests and sessions they point at (at most 83 bound parameters per statement, D1 allows 100). `since` is exclusive. Null reads the whole history.
- There is no stored edit-and-resend event. A resend is inferred: the same person's next user message after a run they cancelled in that session.
- Tags: `private` (a private or ui session of one person, with that person's `userId`), `outside` (mail, an A2A peer anywhere in the run chain, a guest, a mail-trigger run), else `workspace`. Outside wins over private and keeps the `userId`.
- Dream-written memory changes are left out. Dry-run sessions, runs, requests and proposals are left out.
- The character budget counts text only, newest first, and the result reports what it dropped by kind.

## Nits left

- No test for a resend after a cancelled dry run, a rejected skill proposal by a dry run, or a guest-actor run.
- The rejection skip checks `run.dryRun` only, not a `dry_run` session.
- Web-fetch runs are not tagged outside (the memory service tags them `web`). Text from trigger webhooks is tagged `workspace`.
- A resend item repeats the original and resent text, so both count against the budget. Truncation can split a surrogate pair.
- A person-undone agent note shows as a plain `memory_change`, not as a rejection signal.
- One extra query per user message in a session that has a cancelled run. Cancelled runs of a touched session are read across all time.

## Ideas beyond the scope

- Persist an edit-and-resend event when a person edits a sent message, so the dream does not infer it.
- Share one outside-source rule between this file and `memory/guards.ts` `outsideSourceOf`, including web and webhooks.

## Steps for Dom

None.
