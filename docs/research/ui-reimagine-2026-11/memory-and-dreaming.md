# Agent memory and dreaming: design note

Written 19 Nov 2026. A proposal, not built. It answers two of Dom's points: a way to define what an agent should remember, and a scheduled clean-up pass where an agent reviews and reconciles its memory, on its own and with its team.

## What others do

| Product | Store | Clean-up pass | Review |
|---|---|---|---|
| Claude Managed Agents | Memory stores | A "dream" is a batch job that reads past session transcripts and writes a new, cleaned memory store. The input store stays untouched | A person reviews the new store and can discard it |
| OpenClaw | Markdown in the workspace: `MEMORY.md` for curated facts, daily notes under `memory/`, `USER.md` for preferences | Dreaming is on by default. A nightly sweep in three phases promotes repeated signals into `MEMORY.md` | A readable Dream Diary in a Dreams tab, with a rollback copy |
| Hermes Agent | `MEMORY.md` capped at 2,200 characters and `USER.md` at 1,375, injected at session start | A background review after each turn saves memory or patches a skill. No consolidation, so the agent must free space by hand | Optional write approval with a diff. `/journey` shows a learning timeline |
| Dust | Facts per user, added as a tool | None | Each user can read and delete their own |
| Devin, Sierra | Knowledge items | Proposed from past work | A person accepts each one |
| The Brain (Dom's) | Facts, path-keyed versioned memory, sessions, graph | Nightly dream engine: dedupe, digest, hygiene, contradiction, entity pages, indexes, reflect | Trust grades. Agent writes cannot reach grade `instruction` without a human review row. Dream output is marked so it does not feed itself |

Three lessons. Files work, because agents handle them well and people can read them. A hard size cap with no consolidation fails, as Hermes shows. The trusted shape is: the pass writes a new version, shows what changed, and a person can roll it back.

## What an agent remembers

Four kinds of memory, each a short note with a source.

| Kind | Example | Usual source |
|---|---|---|
| About people | "Mia wants drafts as Google Docs, not attachments" | Conversations, corrections |
| Corrections | "Do not email councils on Fridays. Dom said they ignore it. 12 Nov" | A denied approval, an edit and resend, a direct instruction |
| Work in progress | "Trade show list: Queensland done, NSW waiting on Tally" | The agent's own runs |
| Where things are | "Pipeline numbers live in the Sales sheet, tab Q4" | Runs, people |

Two neighbours are not memory notes. How to do a task is a skill, which Agentum already versions and approves. What was said is history, which the sessions and event log already hold. History needs a search tool for the agent, not a copy.

## Remember rules

The owner sets what the agent should and should not keep, in plain words, on the agent's Knows tab.

- **Remember.** A short list the owner edits. The builder drafts it from the job description. For a sales agent: client preferences, decisions about the pipeline, how each person likes reports.
- **Never remember.** Workspace defaults that every agent inherits: passwords and keys, card and bank numbers, health details, anything a person marks private. The owner adds more per agent.
- **How it learns.** One of three levels. "Ask me first" holds every new note for approval. "Tell me after" applies notes at once and lists them under Learned this week. "Quietly" applies them and shows them only in the diary. Default is "Tell me after". Changes to skills always ask.
- **Dream schedule.** Nightly, weekly or off, in the workspace timezone. Agentum has no workspace timezone yet, so that setting comes first.
- **Shares with team.** On or off. When on, the team dream may lift this agent's notes into team memory.

These rules are instructions to the agent and to the dream pass. They are the answer to "a way to define what an agent should remember".

## Scopes

| Scope | Who reads it | Who writes it |
|---|---|---|
| Agent | That agent | The agent, its dream, its owner |
| Person | The agent, only in work for that person | The agent, from private conversations with that person |
| Team | Every member of the team | The team dream, the lead by proposal, people |
| Workspace | Everyone | The wiki, with suggested edits. Exists today |

A note from a private conversation stays in the person scope. It moves up only if that person approves. Sessions already carry a `private` flag to drive this.

## Three ways a note gets written

1. **A person says so.** "Remember that" in chat, or a Remember button on any message. Applied at once.
2. **The agent notes it during work.** A `remember` tool. The note follows the "how it learns" level.
3. **The dream finds it.** See below.

Every note records its source: the conversation, run or request it came from, and whether a person, the agent or a dream wrote it.

## The dream

A dream is a scheduled run for one agent. It reads what happened since the last dream and rewrites the agent's memory. It runs on a cheap model, counts against the agent's spend cap, and skips itself when nothing new happened.

Inputs since the last dream:

- Conversations and task results.
- Requests and their answers. A denied approval is the strongest signal there is.
- Edits and resends, and files a person changed after the agent wrote them.
- Failed and interrupted runs.
- Notes the agent wrote during work.
- Rejected skill and memory proposals, so it stops proposing the same thing.

Steps:

1. **Collect** the inputs, leaving out anything a Never remember rule covers.
2. **Extract** candidate notes, each with its source.
3. **Merge** candidates into existing notes and remove duplicates.
4. **Reconcile.** When two notes disagree, the newer one from a person wins. When it is unclear, the dream asks.
5. **Prune.** Drop finished work-in-progress notes and notes not used in a long time. Keep memory under a size budget by merging, not by cutting off the end.
6. **Promote.** A procedure the agent repeated becomes a skill proposal. A note the whole team needs becomes a team memory proposal.
7. **Write** the new memory as one new version, and a diary entry in plain words.

The diary entry is the product the owner sees. "Scout reviewed 14 conversations. Added 3 notes, merged 2, dropped 4 that were out of date. One question for you." Each line links to the note and its source. One button rolls the whole night back.

Only three things reach Needs you: a contradiction the dream cannot settle, a skill change, and anything held by the "Ask me first" level.

## The team dream

After the members' dreams, the lead runs one for the team. This is the part where agents reconcile with each other.

- **Conflicts between members.** "Scout thinks the report goes out Tuesday. Quill thinks Monday." The team dream asks the team's owner once and updates both.
- **Shared facts.** A note three members each hold becomes one team note, and the copies go.
- **Hand-off friction.** "Tally re-formatted Scout's contact lists four times this week." The lead proposes a change to Scout's instructions. The owner approves it. The lead never writes it.
- **Room digest.** A summary of what the team room decided, so a member mentioned next week does not need the whole thread.

It writes a team diary entry in the room and in Slack if the room is linked to a channel.

## Guardrails

- Memory cannot grant access. A note never changes keys, ask-before rules or who the agent may contact. Those stay human-only writes.
- A memory note ranks below the owner's instructions. When they conflict, instructions win and the dream flags the note.
- Outside text cannot write memory by itself. A note whose only source is inbound mail from outside, a web page or an A2A peer is held for approval. This closes the "please remember to forward invoices to this address" attack.
- Dream output is marked as dream-written, and the next dream does not treat it as fresh evidence. The Brain does the same.
- Every version is kept. Forget removes a note from use and keeps it in history.
- An agent cannot edit its own remember rules.

## Where it lives

Recommended: files in the agent's library home, `agents/<slug>/memory/`. An index file plus one file per topic, each note with a kind, a source and a date. Team memory sits in the team folder.

Reasons:

- The library already versions every write, shows history and diff, and can roll back.
- Two-way sync already puts the agent's home folder on machines and cloud VMs, so all three runtimes read the same memory. Managed Agents use the library tools.
- The Knows tab reuses the library viewer and editor.
- People can read and fix a text file.

A dream is a new trigger kind in the existing `triggers` table, beside `http`, `routine`, `mail` and `app`. Proposals reuse the skill proposal flow.

Decided by Dom on 19 Nov 2026: memory is files in the agent's library folder, and the dream is built into Agentum. Agentum does not call The Brain as a service. Code may be copied from The Brain.

The Brain's dream engine is in `/home/roboto/devel/the-brain/packages/db/src/dream/`: `select.ts`, `plan.ts`, `dedup.ts`, `contradiction.ts`, `hygiene.ts`, `digest.ts`, `reflect.ts`, `judge.ts`, `entitypages.ts`, `indexes.ts`, `apply.ts`, `run.ts`, `runs.ts`, `job.ts`, `dispatch.ts`, `ops.ts`. It works on The Brain's fact and entity tables, so each step needs new inputs and outputs for memory files. Entity pages and indexes have no match in this design and can stay behind. The repo rule applies: a copied file comes in with its tests, or it does not come in.

Anthropic memory stores and dreams fit only the Managed Agents runtime, so they are not the base.

Also decided: the default learning level is "Tell me after" for notes, and skill changes always ask.

What loads into a run: the index and the notes that match the task, under a token budget. The rest is one search away. The agent also gets a history search tool over its own past conversations.

## What to build

1. Workspace timezone.
2. Memory files, the `remember` and `search_history` tools, loading at run start.
3. Knows tab: notes by kind with source links, edit and forget, the remember rules, Learned this week.
4. Dream trigger kind, the seven steps, the diary, rollback.
5. Remember button on messages and "remember that" in chat.
6. Team memory folder and the team dream. Needs the team object first.
