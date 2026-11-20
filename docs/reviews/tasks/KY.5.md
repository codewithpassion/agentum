# KY.5 review: Keys tab on the agent room

## Verdicts

Round 1 (b08c6e0c): not clean, one must-fix. An app that runs on a workspace secret has no personal sign-in, so its row said "You have not signed in yet." or "The agent has no sign-in yet." It now shows "Key from secret X" (or the needs-secret notice) and never claims a sign-in is missing. Fixed with the nits below in a8ca7986.

Round 2 (a8ca7986, the fix commits only): clean. It also confirmed the controller's widened scope: assigning a catalogue connector sets the assignment's allowed tools from the entry's `defaultAllowedTools`, found by `catalog_key`. `connectors.list` now returns `catalogKey`, so this covers a fresh catalogue add (admin) and a catalogue connector the workspace already has.

After round 2, with no new review: removed the orphaned `toolAccessLabel`, and block adding a catalogue connector when `catalog.list` fails (its defaults are unknown), renamed a misleading test, mapped the connector status badge to plain words, and hid "Uses the sign-in of the person asking..." for apps with no sign-in or a workspace secret.

Browser proof passed at 1280x800 and 390x844 for admin and member, see `docs/reviews/tasks/KY.5/browser.md`.

## Nits left

- The Slack summary line repeats what the Slack panel shows, and the agent's own sign-in line is redundant next to the status sentence.
- Adding from the catalogue is two calls (`catalog.add`, then `connectors.assign`). A failure between them leaves a connector the agent does not have, which the add menu then lists under "Already in this workspace" with its default tools.
- `slack.tsx` now invalidates the page data after a change so the Keys summary stays right.
- The connector status badge keeps its variant, and a secret-backed app keeps its mode select.
- "Connect my account" stays visible when the mode is "Its own".
- An app with no cached tool list gives an Allowed tools dialog with only "Clear list", so a catalogue app cannot be narrowed until its tools are fetched.
- A member sees the full workspace secret list and the grant switch in "Passwords and keys" (the old Secrets sheet did too).
- `GET /favicon.ico` returns 404 on every page. The app has no `public/` folder. It predates this task.

## Ideas beyond the scope

- One service call, `catalog.addAndAssign(agentId, key)`, so the add is atomic and members never need the two-step path.
- Fetch a catalogue app's tool list when it is added, so Allowed tools has something to pick from.
- Hide "Connect my account" when the mode is "Its own" and the person is not the one asking.

## Steps for Dom

- Connecting Gmail, Linear or Notion needs a real vendor account. The browser proof went as far as the vendor sign-in page, since local OAuth clients are not registered for localhost. After deploy, connect one catalogue app on staging as a member from the Keys tab to confirm the whole round trip.
- KY.5 reads `catalog.list` and `catalog.add` from KY.4, which is already on main.
