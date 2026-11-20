# Agent memory format

## Where memory lives

Memory is files in the agent's library home, `agents/<slug>/memory/`. The home is `agents/<slug>`, see `packages/services/src/library/home.ts`.

The memory folder holds these files:

- `people.md`, `corrections.md`, `work.md` and `places.md`, one file per note kind. The file name is the kind.
- `index.md`, generated. See the index section below.
- `private/<userId>.md`, notes from that person's private conversations, of any kind. `userId` is a Clerk user id.
  A run sees this file only when its session is private or has origin `ui` and the session's actor is that person. One rule, `library/private-notes.ts`, serves the prompt, the library tools, the VM sync, the audience and the session reads. Team rooms, Q&A, Slack channels, mail, artifact chats, A2A, routines and triggers never get it, even when that person started the run.

Working copies of the library, on a Linux VM or on a machine, outlive a run and are shared by every session of the agent. So `private/` never syncs into them, in either direction, and each run starts by removing any `agents/*/memory/private` folder from the copy. A run gets its person's private notes from its prompt. The rest of the memory folder syncs as a read root, because a run never writes there.

Only the memory service (`@repo/services/memory`) writes these files for agents, dreams and the Knows tab. Each write is one library version, so history and rollback come from the library. A person may also fix a file by hand in the library editor. A file that does not parse is reported with its line number, left untouched, and never overwritten. While a file does not parse, the service refuses new notes of its kind and says why.

## Kinds

| Kind | What it holds | Example |
|---|---|---|
| people | Something about a person | "Mia wants drafts as Google Docs, not attachments" |
| corrections | What the agent was told to do differently | "Do not email councils on Fridays. Dom said they ignore it. 12 Nov" |
| work | Work in progress | "Trade show list: Queensland done, NSW waiting on Tally" |
| places | Where things are | "Pipeline numbers live in the Sales sheet, tab Q4" |

## The note block

A note is a list item of fixed lines. The first line starts with `- `. Each later line is indented two spaces and holds one field as `key: value`, with one space after the colon. Fields come in this order: id, kind (private files only), date, source, by, text.

| Field | Rule |
|---|---|
| id | A 26 character ULID. Unique across all of the agent's memory files, so edit and forget find a note by id alone. |
| kind | One of `people`, `corrections`, `work`, `places`. Only in `private/<userId>.md`, where the file name gives no kind. In the other four files it must be absent. |
| date | `YYYY-MM-DD` in UTC, the day the note was written. |
| source | `session:<id>`, `run:<id>` or `request:<id>`, the session, run or request the note came from. `none` for a note a person typed by hand. |
| by | `person`, `agent` or `dream`. |
| text | One line of 1 to 500 characters, with no leading or trailing space and no line break. The value is everything after the first `: `, so text may contain colons. The service turns line breaks and runs of whitespace into one space, trims the ends, and only then counts characters. |

The field is named `by` here and `written_by` (`writtenBy` in the types) on a change row. Notes are separated by one blank line and kept oldest first. A file is a title line, a blank line, then the notes, and ends with one newline. A file with no notes is the title line and one newline.

An edit keeps the note's id and source, replaces its text, and sets its date and `by` to the day and writer of the edit.

Titles: `# People`, `# Corrections`, `# Work`, `# Places`, `# Private notes`. The title is ignored when parsing and rewritten when serialising. Serialising what was parsed gives the same bytes.

## The index

`index.md` is rebuilt by the memory service after every change and never edited by hand. Its title is `# Memory index`. Then comes one section per kind that has notes, in the order corrections, people, places, work. Each section is headed with its name and note count, such as `## Corrections (2)`.

The index is the title, then each section, with one blank line between the title, each heading and its list. An agent with no notes gets the title line and one newline. Each section lists its notes newest first. Notes sort by date, and ties go to the note later in the file. Each entry is `- <id>: <text>`. The text is cut to 80 characters, trailing spaces after the cut are dropped, and `...` is added when it is cut.

Private notes never appear in the index, because everyone who may read the agent's memory can read it.

## The change log

Every change also writes one row in the `memory_changes` table (columns in `packages/db/src/schema/memory.ts`). The action is `add`, `edit`, `forget` or `merge`. The status is `applied`, `held`, `rejected` or `undone`. Forget removes the note from its file and keeps the history in library versions. A merge writes one `merge` row for the note that stays (its `note_id`, with the merged text) and one `forget` row for each note it absorbed. These rows share a `group_id`, which is the id of the `merge` row. They are written together, in one call, with one status: all `applied` with the same `library_version_id`, or all `held` with none. A decision (`decide`) or an undo on any row of a group acts on the whole group. A note a dream writes has `by: dream` and the source it learned the note from, and its change row also names the dream in `dream_run_id`.

A row links to the library version it wrote through `library_version_id`. That column stays empty while a change is held and when it is rejected.

The rules are not in these files. What to remember, never remember, learn level, share with team and dream schedule are JSON in `agents.remember`. The workspace's never list is `workspaces.never_remember`.

## The never list on write

The memory service checks every add and edit against the workspace's never list and then the agent's own, before the learn level. An entry matches when its words appear in the note as a run of whole words, ignoring case and punctuation and a trailing `s`. An entry that lists alternatives with commas, semicolons or slashes (`Salary, bonus`) matches any of them. The words `and` and `or` do not split an entry, so a default such as `Health details` matches only a note that says those two words in a row. The prompt still tells the agent the whole topic. A person's note is checked too, and a forget never is.

A note that matches is refused with an `invalid` error naming the entry and the list, which the `remember` tool hands back to the agent. The service writes one `memory_changes` row with status `rejected` and `decided_at` set, no `decided_by` and no library version. The row's text names the entry and does not repeat the note, because the topic is one the owner does not want kept.

## Examples

`agents/scout/memory/people.md`

```markdown
# People

- id: 01HZ7KQ3M8V2X4R6T9B1C5D0EF
  date: 2026-11-02
  source: session:01HZ5P8Q2W6M4R9T1Y3B7N5C0D
  by: agent
  text: Mia wants drafts as Google Docs, not attachments

- id: 01HZ8A2N7PW5G3J6D9K4QS1YXM
  date: 2026-11-10
  source: none
  by: person
  text: Tom reads reports on his phone, so keep tables short

- id: 01HZ9B6R4T8C2V5M1F7H3K0NDP
  date: 2026-11-14
  source: run:01HZ9B2K6M4W8R1T5Y9C3D7F0G
  by: dream
  text: Priya owns the newsletter list and wants open rates each week
```

`agents/scout/memory/private/user_2abc.md`

```markdown
# Private notes

- id: 01HZA3E8W2Q6R9T4Y7M1B5C8XG
  kind: people
  date: 2026-11-16
  source: session:01HZA1C4N8P2T6W9Y3R7M5D0FE
  by: agent
  text: Anna in Brisbane prefers a call to email when pricing changes

- id: 01HZB7F5K3N9P2D6S8V4H1J0ZR
  kind: work
  date: 2026-11-18
  source: session:01HZB4G7M2Q5W8T1Y6R3N9C0DA
  by: person
  text: Partner brief draft waits on the pricing table from Tally
```

`agents/scout/memory/index.md`

```markdown
# Memory index

## Corrections (1)

- 01HZC2G9T5W1Y8M3Q6R4B7N2XK: Do not email councils on Fridays. Dom said they ignore it. Send them mail on Tue...

## People (3)

- 01HZ9B6R4T8C2V5M1F7H3K0NDP: Priya owns the newsletter list and wants open rates each week
- 01HZ8A2N7PW5G3J6D9K4QS1YXM: Tom reads reports on his phone, so keep tables short
- 01HZ7KQ3M8V2X4R6T9B1C5D0EF: Mia wants drafts as Google Docs, not attachments
```
