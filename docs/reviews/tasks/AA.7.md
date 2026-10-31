# AA.7 review record

Agent connections pages, join page, agent profile section, Needs you items. Branch `task/AA.7-connections-ui`.

## Verdicts

- Round 1, at f0c6190d: not clean, 4 must-fix. The detail page's Approve did not show the OAuth token URL it sends. The Needs you connection card approved from a fresh read, so its `seen` check could never fail. The "Call it" dialog claimed the credential goes only to the previewed host, but `addOutbound` refetched the card with no check. A revoked connection showed when but not who.
- Fix commit af92023a: the detail page shows the token URL and sends it as `seen`. A Needs you card approves only a Harbourmaster peer whose host is still the one the card showed, and sends an outside agent to its own page. `previewCard` returns the origin and token URL and vets the token URL, and `addOutbound` takes `seen` and refuses a card that moved. `a2a.manage` returns `revokedBy` (a name, "the system" or "the other side"). It also took the cheap nits: Decline not gated by the approve reason, revoke words by kind of peer, `?join=` cleared on close, profile card and Hermes wording, `break-words` on peer text.
- Round 2, at af92023a: clean, no must-fix. 0 failures in `bun run check`, `bun run test`, `bun run build`, and no `drizzle` in `apps/web/dist/client`.

## Browser check

Local deployment on port 3927, two workspaces on one Clerk dev instance. Workspace A is the dev user from `create-dev-user`. Workspace B is a second user and organisation (`aa7-second-workspace@example.com`, "AA7 Second Workspace"), made with a scratch script and added to `ALLOWED_ORG_IDS` in the worktree's `.env.local`. B signed in with `bun run agent-login --base-url http://localhost:3927`. Both sessions ran in agent-browser against headless Chromium. Screenshots are in `/home/roboto/devel/harbourmaster-wt/tmp/AA.7/shots/`.

AA.4 (the `/a2a` routes) and AA.5 (the pairing transport and outbox) were not merged, so three steps used scratch scripts that are not in the diff. The end-to-end path over HTTP is left to AA.8.

1. A published agent "Alice Support" through Invite (publish form, then link shown once with Copy). Done in the UI.
2. B opened the invite link. Signed in, `/connect/<token>` went to `/settings/agent-connections?join=<link>` with the Join dialog filled in. Done in the UI. The first try showed "Connector not found": `/connect/:id` is also the connector OAuth start in `server/routes/connectors-oauth.ts`. That route now passes `hm_inv_` ids on to the page, with a test.
3. B's Join without publishing showed "Publish the agent first". The Join dialog now wraps its button in the publish gate. B published "Bob Helper" in the dialog and pressed Join. The app has no pairing transport yet ("Joining by link is not set up here"), so the join itself ran in a scratch script that built both connection services over the same local D1 file, with a transport that calls the inviter's `join` in process. B's row went `awaiting_peer` with check code DU5N728E.
4. A's Needs you showed "Bob Helper wants to connect" with host, organisation, and the same check code. Approve was pressed in the UI and A's row went `activating`. The outbox delivery (AA.5) is not there, so a scratch script decrypted the queued activation row, called B's `activate` with it, and marked A's row delivered. Both rows read Active in both workspaces.
5. A key was made in "Give it a key". The key, card URL and the Hermes `a2a_agents` block with the approval note showed. A scratch script called the tasks service with the key (standing in for `/a2a` `SendMessage`). The task landed in A's Needs you with sender, host and full text, shown as plain text (a literal `<b>` stayed literal). Approve started a run. The run failed because the test agent's model name was invalid, which is unrelated. The run page, sessions list and receipt name the sender ("Hermes three (outside agent)", "From outside agent") and the run title is the peer's own words, not the envelope.
6. Revoke from the list, with the confirm text. The row went Revoked and the script's next call was refused ("the key is not accepted").
7. "Call it" was not run against a real card: `fetchCard` is not wired in `composeWith` until AA.5, so Look it up answers "not set up here". The dialog layout was checked at 375 px and the service paths are covered by tests.

Screenshots, desktop and 375 px, were read for: the list (empty, with rows, with a revoked row), the detail page with the policies and a widening warning, the invite dialog (publish form, link), the Outside agent dialog (key and Hermes help, Call it), the Needs you message card, the Needs you connection card (desktop), the agent profile section, the run page, and `/connect/<token>` signed out. Fixes from looking: the table overflowed at 1280 px (directions as text, actions wrapped), the dialogs had no scroll (`max-h-[90dvh] overflow-y-auto`), the Outside agent tabs showed both panels (`data-[state=inactive]:hidden`), and a new invite row said "Unnamed agent".

Permission checks are router tests (`apps/web/src/server/trpc/a2a-router.test.ts`): a member is refused on approve, widen, publish, invite and key, and is allowed on revoke, list and read. The disabled-with-reason state for a member was not driven in a browser because only admin sessions were available.

## Nits left

- Revoke words for an outside agent we call still mention declined messages and cancelled runs, and an unused invite reads "Invite not used yet can no longer send...".
- Peer host and organisation text on the detail page and in the Outside agent preview has no break class, and `break-words` on the list's Peer cell does nothing in the nowrap desktop table.
- `seen` on `addOutbound` is optional, so the check is opt-in. The dialog always sends it.
- Approve on a Needs you card for an outside agent is enabled and then refuses with "Open this connection". The card data carries no peer kind.
- After a "destination changed" refusal the dialog and the detail page keep showing the old destination until a reload or a new Look it up.
- The detail page repeats the origin and token URL logic of `approvalSeen`. `errorMessage` is declared in about eight files while `components/triggers/format.ts` exports it. `isWidening`, the `unpublish` procedure and `PAGE_READ_ACTION` (same value as `READ_ACTION`) have no use or duplicate one.
- A skill key in the preview collides when a card lists two identical skills (a React warning).
- `previewCard` repeats about 20 lines of `addOutbound`.
- `?join=` is cleared on close, but "Sign in here" on the signed-out join page has no way back to the link, because `/login` takes no redirect.
- `connect.$token` uses `a2a.list` as its sign-in probe and shows the signed-out text on any failure, a network error included.
- The profile loader turns a failed connections read into "No connections".
- Outbound tasks on the detail page show no decider, because the table has no such field.
- No test for a `seen.tokenUrl` mismatch in `addOutbound`, an OAuth token URL in `previewCard`, or the `peer` case of `revokerOf`.
- `components/requests/request-card-logic.ts` has no wording for an answer a peer gave (AA.3 review file asks AA.7 for it). Not done, since a peer's answer to a run request is only a question's reply and the card shows the connection already.

## Beyond the task

- The Hermes `a2a_agents` YAML is a map keyed by the agent's name with `url` and `auth: { type: bearer, token }`. The shape under `a2a_agents` (map or list) is a guess from the design text. AA.8 should check it against a real Hermes.
- A Needs you "Look at it first" link on connection cards goes to the detail page. A card could show the full origin and token URL itself once the desk card carries them.
- `resolveActorDisplays`, the run title and `StartedBy` now know peers, so any later view that shows an actor gets a peer label from the connection row.

## Steps for Dom

- None that need an account or dashboard. The scratch Clerk user `aa7-second-workspace@example.com` and its organisation "AA7 Second Workspace" exist in the dev Clerk instance and can be deleted from the dashboard.
- AA.8 should repeat items 3, 4, 5 and 7 over real HTTP once AA.4 and AA.5 are merged, and read the Hermes YAML against a running Hermes.
