# DR end-to-end: the dream walkthrough

Task DR.7, on branch `task/DR.7-dream-e2e`. The walkthrough ran on local with the real model (`claude-haiku-5-5`, $0.10 in and $0.50 out per million tokens) through the app's own Dream now button, at 1280x800 and 390x844. A fresh verifier ran it from a prepared local database and wrote `docs/reviews/tasks/DR.7/browser.md` with 36 screenshots. Verdict: pass. Every flow works at both sizes. No dream failed, and no console, page or server error showed after sign-in.

## What ran

The seed is `bun scripts/dev/seed-fake-agent.ts` plus `scripts/dev/seed-dream.ts` (new in this task). The second script writes Slack conversations for an agent into the local D1 database: set 1 is ten conversations, and sets 2 to 4 are small batches for later dreams. Round 2 uses other names and times so the phone pass meets fresh data. The workspace key went into the local database through Settings, from a shell variable, and appears nowhere in the repo or these docs.

| Check | Result |
|---|---|
| Ten conversations with a duplicate, a correction and a contradiction, then Dream now | Works. The card, diary, See changes, notes and Learned this week all agree with the database. Findings 1 and 2 below say what the model did with the three cases. |
| A question in Needs you, answered | Works, with two disagreeing notes written by hand (see finding 2 for why the conversations alone gave none). "Keep this one" drops the other note and marks the question answered. |
| Undo this night | Works. The notes return to what they were and the run and its changes are `undone`. The skill proposal stays pending (finding 4). |
| DR.5, a repeated procedure becomes a skill proposal | Works. Three runs of one procedure gave one proposal, listed in the diary, on the Skills page, under "Proposed by this agent" and in Needs you. After a reject, a later dream with the same procedure filed nothing new. |
| DR.8, approve or reject a held dream | Works. With "Ask me first" the card shows the held changes with Approve and Reject, and Needs you shows a card that opens them. Approve applies the notes. Reject leaves memory as it was. |

## Cost of the real-model run

The 24 dreams across the rehearsals and the two verifier passes cost $0.0230 in all. The verified pass of 8 dreams used 39,752 input and 8,269 output tokens and cost $0.0081. A dream over ten conversations costs about $0.0015 to $0.0018, and a small batch costs $0.0006 to $0.0008. The usage row on `dream_runs` holds the same numbers the verifier summed.

## Fixed on this branch

- A rejected skill proposal is evidence for the promote step only. Before, the extract step also read it and wrote a note such as "A proposed skill ... was rejected, so do not assume it exists as a reusable skill" into memory. `run.ts` now keeps `skill_proposal` items out of extraction, with a test that fails without the change.
- `scripts/dev/seed-dream.ts` is new. Review round 1 found that it backdated seeded conversations by seconds, so a dream that started just before a seed would skip them. It now stamps them at the current time, and a spare fact that tripped the never list (a "code" note) is reworded.

## Findings and proposed tasks

Ordered by how much they matter. Each proposed task has a scope and a check. None is done here.

### 1. A correction does not replace the older note

Seen in both rounds. A hand-added note "Client lunches with Northwind are on Fridays at 1pm" stayed beside the dream's new note "The Northwind client lunch is at 1:30pm, not 1pm". The extract step wrote the correction as an `add`. The merge and reconcile steps only compare notes of the same kind and the same scope (`scopeGroups` in `steps/groups.ts`), and the old note was "About people" while the new one was "Corrections" or "Work in progress", so the two never met. The agent now holds two lunch times.

Proposed task DR.9, "A correction meets the note it corrects". Scope: when a candidate is a correction, or when the merge step looks for duplicates, compare it with every note of the same scope, not only the same kind. A same-scope note that the judge says the candidate replaces is dropped or merged, with the kind of the newer note kept. Check: a service test with a fake model where an `people` note says 1pm and a conversation says it moved to 1:30pm: the plan has one note left. `bun run check && bun run test && bun run build` pass. Then repeat the walkthrough's flow 1 and read the notes list.

### 2. Disagreements between conversations are settled by the extract call

The seeded contradiction (one person says invoices are paid on Thursdays, another says Fridays, with no sign of a change of mind) never reached the reconcile step. The extract call saw both messages and wrote one note, "Supplier invoices are paid on Fridays, not Thursdays as previously noted", which invents a history. In round 2 it wrote a hedge instead: "Supplier invoice payment day is unclear ... confirm before relying on either". Neither made a question. The only way to get a question in Needs you was two hand-written notes of the same kind, which is what the verifier did. The reconcile rule also lets a newer person note win outright when it is strictly newest, and notes made on one day share a date, so a question is the usual result there.

Proposed task DR.10, "Extract keeps a disagreement for reconcile". Scope: change the extract prompt in `extract.ts` so two pieces of evidence that disagree, with no word of correction, become two candidates, and so a note never says "previously noted" or "unclear, confirm". Check: extract tests with a fake model for both shapes. A real-model run of two people disagreeing in two conversations ends with a question in Needs you. The cost of that run is in the diary's usage row.

### 3. The card keeps wording that is no longer true

After Approve, the card still opens with "These changes wait for your approval. Wants to add 3 notes." and the "Would add:" lines, then adds "You approved these changes." After Reject it keeps that text under a Rejected badge. After a question is answered, the diary still says "1 question is waiting for you." After Undo, the diary still says "Proposed a skill" while the skill is still pending. The diary is written once when the dream ends and the card does not change it.

Proposed task DR.11, "The dream card states what is true now". Scope: in `components/agent/room/knows/dream/`, show the state line (held, approved, rejected, undone, question answered) in place of the held and question sentences once they no longer apply, and word the "Would add" lines as past tense after approval. Check: component tests for held, approved, rejected, question answered and undone, and a browser pass at both sizes.

### 4. A skill proposal outlives Undo and Reject

The proposal is assigned to the agent at once ("No approved version yet, follows latest approved") and stays assigned after a reject. Undo this night does not withdraw it, though the undone diary still lists it. This is by design in DR.5 (skills always ask), so it is a product question rather than a bug.

Proposed task DR.12, "Undo and Reject clean up a proposal". Scope: decide with Dom whether Undo should withdraw the night's proposal, and unassign a skill whose only version was rejected. Check: service tests for both, and the Knows tab no longer lists a skill with no approved version after a reject.

### 5. There is no way to run a dream without the real model

`compose.ts` builds the dream with the plain `fetch` to `api.anthropic.com`. On local the only choices are the real key or no dream, so the walkthrough costs money, depends on a key and is not repeatable: in one verifier pass the model kept two of the three seeded facts. The seed script cannot make a question or a held batch appear on demand.

Proposed task DR.13, "Dream with a scripted model on local". Scope: when `devFakeRuntime` is on, route the dream's model calls to a scripted judge (the one in `dream/test-dream.ts` is a start) that answers from a small fixture. Check: Dream now on a seeded agent with no key gives the same diary, a question and a held batch every time, and a production build refuses the switch (a test, as `compose-a2a.test.ts` does for loopback).

### Smaller things

- The diary repeats the counts: the first diary line "Added 4 notes." shows again as a grey summary line, and long diary lines are cut mid-word ("then post the summa..."). Cosmetic.
- "Learned this week" lists a note someone typed by hand as "Remembered: ..." with an Undo button.
- When a rejected procedure comes up again, the model files it as a note instead ("Month-end close for each Harbour entity ..."). That repeats what the skill says. Fine for now. If it becomes noisy, tell extract to leave procedures to promote.
- The "Keep this one" buttons on the question pane do not show up as refs in `agent-browser snapshot -i`, although they have accessible names and click by name. Check the pane with a screen reader or the accessibility tree before calling it fine. This may only be a tool limit.
- Both browser passes saw one "Failed to load resource ... 400" console error in the dev-login hop (the Clerk ticket redeem) before landing on /home. DR.6 and ME.9 saw it too. It is not part of the dream and showed on no flow page.
- A dream proposed a skill description that says "a client's month" while the conversations name each entity. A wording issue of the model, not of the pipeline.
- Hand notes of one round and the dream's notes of the next can disagree across the walkthrough rounds (stand-up 9:15am and 8:45am both remain). That is a property of running two rounds on one agent, not a defect, but it shows the dream does not compare an old note with a new note of another kind (finding 1).

## Steps for Dom

None need his accounts. To rerun the walkthrough on a clean machine: apply migrations, start the dev server, sign in with the dev login, run `bun scripts/dev/seed-fake-agent.ts`, store a workspace Anthropic key in Settings, then use `scripts/dev/seed-dream.ts` (its header says which set gives which case).
