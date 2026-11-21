# TX milestone gate, round 1

This review covers `tx-start..origin/main` at d4eadc72, checked against:

- the TX section of `docs/v4/build-plan.md`
- the TX task files
- `docs/reviews/TX-e2e.md`
- CLAUDE.md
- "Rules that are easy to break" in `docs/HANDOVER.md`

TX.10, TX.11 and TX.12 moved to the backlog when Dom froze the scope, so this review leaves them out.

The gate reviewer split the work between two helper reviewers but never wrote this file. The controller wrote it from their two reports.

## Verdict

Not clean. There is one must-fix, a security bug in the TX.8 hand-off retry, and 7 nits.

## Checked and sound

**Discussions and the contract (TX.1, TX.3).**

- **Schema and migration.** The `discussions` table and migration 0060 are sound, and the hand-edit to `dream_questions` is intact. The owner CHECK constraints are present on `dream_runs`, `memory_changes` and `dream_questions`.
- **Rounds and starts.** Rounds stay within 1 to 5 at both the MCP tool and the service. Only a team's lead, during its own room run, can start a discussion. Concurrent starts are serialized.
- **Wakes.** No member is woken twice in a round, because the request key is unique per round. The budget holds, the participant list is fixed, and the hourly wake limit still applies.
- **No stalls.** A silent member does not stall a round. A lead that never replies ends the discussion after 20 minutes.
- **Stop.** Stop needs a browser session with access to the topic.
- **Tests.** The targeted tests pass.

**Team memory and the team dream (TX.2, TX.6, TX.8, TX.9).**

- **Private notes.** The team dream loads only notes from members that share with the team, and never private notes. It reads only room topics that are open to the whole team, and room text reaches the model escaped and marked as data. The question, lift and hand-off thresholds are enforced in code.
- **Who may act.** Dream now, Undo and answering a team question need the team owner or an org admin on a browser session. The desk shows a team question only to them, and TX.9 changes only its heading.
- **Writes and spend.** Writes land together in one commit. Undo refuses a file that changed since the dream. A team dream checks the workspace cap before it starts and enforces it after, and its usage counts toward the workspace.
- **Diary timing.** The 08:00 diary slot is correct, and the same diary is not posted twice.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | The TX.8 hand-off retry matched any post in a "Team diary" topic that started with `HAND_OFF_HEADING`, whoever wrote it. It then woke the lead with the team owner as the waker. A member, or an agent using `inbox_post`, could make the lead run as the owner, with the owner's identity and user-mode credentials. A scratch test proved it. | `dream/team/hand-off-retry.ts:33-50` | TX.13 |
| 2 | nit | A discussion whose lead is over its hourly wake limit ends as `done`, with no note in the room. | `teams/discussions.ts:391-393` | Backlog |
| 3 | nit | Refused member wakes repeat every minute and log an `inbox.loop_stopped` event each time. | `teams/discussions.ts` | Backlog |
| 4 | nit | Discussion wakes are counted with an unescaped `LIKE` pattern. It is harmless with the current id format. | `teams/discussions.ts:401` | Backlog |
| 5 | nit | A member's daytime Dream now can start a team dream at the next tick. | `dream.ts:592` | Backlog |
| 6 | nit | A topic someone names "Team diary" is skipped by the dream. | `collect.ts:174` | Backlog |
| 7 | nit | Undo after an answered team question leaves the answer in place. | team undo | Backlog |
| 8 | nit | A team dream refused at the workspace cap retries every minute. | `dream.ts` | Backlog |

## Must-fix 1: only the system's hand-off post wakes the lead

Scope: the retry query matches only posts the system wrote, and `retryNoticeWake` refuses any other post as a second guard.

Check: a member's look-alike post wakes nobody, and the system's own post still gets its one retry.

## Controller decisions (2026-11-21)

- Must-fix 1 became TX.13. It was merged after a clean review and deployed to staging and production the same day. Production held no Team diary post by anyone but the system, so nobody used the hole.
- The nits are recorded in `docs/backlog/v4-later/README.md`.
