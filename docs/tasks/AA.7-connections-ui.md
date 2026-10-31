---
id: AA.7
title: "Agent connections pages, join page, agent profile section, Needs you items"
milestone: AA
size: L
status: in_progress
depends_on: [AA.3]
branch: task/AA.7-connections-ui
lane: web
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the sections "What the page shows", "Trust flows" and "Policies on a connection". It wins over anything else. Rail rules: `docs/ux-review/rail/spec.md`.

## Scope
- `apps/web/src/server/trpc/a2a-router.ts`, thin and on `workspaceProcedure`, with an input schema plus one service call per procedure.
- `/settings/agent-connections` under "Access to Harbourmaster" in `settings-nav.ts`, which feeds Find. The list shows my agent, the peer's name and host, which directions are on, status, last activity and Revoke. Pending approvals come first.
- Three ways to add, one dialog each: Invite (pick an agent, publish if needed with the description and skills shown for review, then show the link once with a copy button), Join with a link (paste, pick my agent, show the check code), and Outside agent, split into "Give it a key" and "Call it" (paste a card URL, show its name, host and schemes, take the credential).
- Hermes help, from "Hermes compatibility" in the design. After "Give it a key", show a ready-to-paste `a2a_agents` YAML block and a note that with approval on, a Hermes agent gets "waiting for approval" and not the later answer. "Call it" lists `A2A_PEER_TOKENS`, `A2A_TRUSTED_PEERS` and `A2A_PUBLIC_URL` on HTTPS.
- A connection detail page with policies, the check code while pending, recent tasks in both directions with state and who decided them, and links to the runs. Widening a policy to `auto` or `agent_rules` shows what it allows in plain words, including that a machine agent can run shell commands. It shows disabled with a reason for someone who isn't an admin or the owner.
- `/connect/$token`, on the same deployment and signed in, opens the join form with the invite filled in. Otherwise it shows short instructions to paste the link into the visitor's own Harbourmaster. It reveals nothing about the inviter before a successful join.
- Revoke asks once with a confirm that says what stops.
- A "Connections" section on the agent profile: published or not, count and list of peers, with a link to the page.
- Needs you cards for a waiting message (sender, host, full text, Approve and Decline) and a pending connection (peer, host, org as claimed, check code, Approve and Decline), using the sources from AA.3. Show the peer's text as plain text, never rendered as markdown or HTML, because it is outside input.
- Run and session views label a peer as the sender, using `actor-display.ts`.
- Empty states say what a connection is in one line. Use shadcn components, and hand-edit nothing in `components/ui/`.

## Check
- Router tests for permissions: a member refused on approve or widen, allowed on revoke.
- `find-registry.test.ts` passes with the new page reachable.
- Browser check with dev login, recording the steps in the review file. On one local deployment with two workspaces:
  - invite from one, join from the other, approve, and see both rows `active`;
  - send a message to the published agent with a test script using an access key, and see it in Needs you, then approve it and see the run;
  - revoke, and see the script's next call refused.
- Screenshot each page at desktop and at 375 px wide, and read each screenshot.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` is empty.

## Log
- 2026-10-31: created.
- 2026-11-01: dispatched.
