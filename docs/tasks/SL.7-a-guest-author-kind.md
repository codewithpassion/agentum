---
id: SL.7
title: "A guest author kind"
milestone: SL
size: S
status: todo
depends_on: [SL.13]
branch: null
lane: slack
executor: claude
---

Proposed by the Slack walkthrough (`docs/reviews/SL-e2e.md`).

Finding. A guest is a user post with the name inside the text, and the room and `slack_search` each parse the `(Slack guest):` prefix. That is two copies of a convention nothing enforces. A topic a guest opens also stores the guest id in `created_by`.

Scope. A contract task adds a `guest` author kind or a `guest_name` column on `inbox_posts`, `postExternal` writes it, and the two readers use it. Existing rows are migrated by splitting the prefix.

Check. Migration test on rows with the prefix. Room and search tests no longer parse text.
## Log
- 2026-11-21: added by controller.
