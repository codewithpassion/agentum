# KY.6 browser verification

Branch `task/KY.6-settings-sign-ins` at `7ab34411`, verified 2026-11-20 by an independent verifier.

## Verdict: PASS

Every flow worked at 1280x800 and 390x844. No KY.6 request failed and the console showed no errors. Two failed requests did happen, but both trace to my fake seed hosts, and the "Not counted" section lists them. A few observations follow that the reviewer may want to weigh. None of them breaks the task's check.

## Setup

- Dev server: `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port 5199` in `apps/web` (local D1, migrations through 0056).
- Admin: the dev user, signed in with `GET /api/dev-login` (org:admin of "Dev Workspace").
- Non-admin: I created the Clerk user `dev+ky6member@harbouredgeintelligence.ai` (`user_3MLtxOSBz4KOWMH8b0gAtVOdq2J`) on the dev instance with `@clerk/backend` from a script outside the repo. I added it to org `org_3KkfBN77ien6ryvH4YDBFjGNw0v` as `org:member`, then signed in with `bun run agent-login --email … --base-url http://localhost:5199 --redirect /settings/sign-ins`. I wrote the URL to a scratch file and opened it in a fresh agent-browser profile. The session landed on `/settings/sign-ins` with no pending state. The member's rail footer shows only Agents, Apps and Files, with no Settings tab (`phone-0-member-rail.png`, `desktop-1.png`), which confirms it is not an admin.
- Connectors: the admin Add dialog refused a made-up URL with "Could not read the tool list from that server.", so I inserted rows into the local D1 sqlite (`apps/web/.wrangler/state/v3/d1/.../ad06eafe….sqlite`) with `bun:sqlite`, from a script in `harbourmaster-wt/tmp/KY.6/`. All rows have `workspace_id` set to the Dev Workspace, `status` `ok` and `created_by` `seed-script`:
  - `Header Test App`: `auth_kind` header, `header_name` Authorization, no secret or template. Saving a sign-in probes the MCP server's tool list, and the URL guard refuses loopback, so I pointed this row at the public no-auth server `https://mcp.deepwiki.com/mcp`, which accepts any bearer value. The only values sent there were the test strings `Bearer test123`, `Bearer test456` and `Bearer admin123`.
  - `OAuth Test App`: `auth_kind` oauth, with an `oauth` JSON config whose `registrationEndpoint` is `https://oauth.example.com/register` and whose `client` is null, so the row offers Connect.
  - `Shared Key App`: `auth_kind` header with `header_template` `Bearer {value}` and no `secret_id`, which `connectors.mine` reports as `shared: true`.
- Logs: I read the browser console with `agent-browser console` after each flow. agent-browser's `network requests` lists URLs but not status codes, so I checked statuses with `performance.getEntriesByType("resource")` and `responseStatus` (looking for >= 400) and with "Failed to load resource" console lines. I also scanned the dev server log.

## Flows

### 1. Avatar menu, "Your sign-ins" (member)

- Desktop: on /home I opened the avatar menu. It lists Manage account, **Your sign-ins** (key icon) and Sign out. Clicking Your sign-ins opened `/settings/sign-ins`, heading "Your sign-ins". `desktop-1.png`, `desktop-1b.png`.
- Phone: same steps and same result. `phone-1.png`, `phone-1b.png`.

### 2. Find (member)

- Desktop: Ctrl+K, typed "sign". Under Settings, "Your sign-ins" is listed with the hint "Your logins". Selecting it opened `/settings/sign-ins`. `desktop-2.png`, `desktop-2b.png`. Searching "apps" listed Settings > "Apps" (hint "Connectors"), which opened `/settings/connectors` with heading "Apps" (`desktop-2c.png`, `desktop-2d.png`). Searching "passwords" listed "Passwords and keys" (hint "Secrets"), which opened `/settings/secrets` with heading "Passwords and keys" (`desktop-2e.png`).
- Phone: the header Find button (magnifier) opens the same dialog. I repeated all three entries with the same results. `phone-2.png` to `phone-2e.png`.

### 3. List, add, replace, disconnect (member)

- The list shows Header Test App "Not signed in" with Add sign-in, OAuth Test App "Not signed in" with Connect, and Shared Key App "Shared by your workspace" with no actions. All three statuses and actions are as expected.
- Desktop: I clicked Add sign-in. The dialog title is "Paste credential for Header Test App", with a Header value field. I entered `Bearer test123` and saved. The status became **Signed in**, and **Replace** and **Disconnect** appeared. I clicked Replace, entered `Bearer test456` and saved, and the row stayed Signed in. I clicked Disconnect. The row returned to **Not signed in** with Add sign-in, and the notice "Disconnected from Header Test App." showed. `desktop-3.png` to `desktop-3f.png`.
- Local D1 events confirm the member owns these credentials: `credential.created` (replaced false), then `credential.created` (replaced true), then `credential.revoked`, each with `ownerId` set to the member's user id. The `credentials` table is empty afterwards.
- Phone: same sequence, same results. `phone-3.png` to `phone-3e.png`.

### 4. OAuth Connect (member)

- Desktop and phone: the Connect href is `/connect/01KY6SEED0000000000000OAU1?as=user&return_to=%2Fsettings%2Fsign-ins`, as expected. `desktop-4.png`, `phone-4.png`.
- Following it gave a plain "Internal Server Error" page (HTTP 500). The dev log shows `getaddrinfo(): DNS lookup failed. host = oauth.example.com`, so the made-up provider host is the cause. KY.6 does not touch the `/connect` handler. `desktop-4b.png`, `phone-4b.png`.

### 5. Admin view

- Desktop: the settings nav shows the group "You" first, holding "Your sign-ins", then "Agents run on", then "Agents can use" with **Apps**, **Passwords and keys** and Artifacts, then "Access to Agentum". The old names are gone. `/settings/connectors` has the heading "Apps" and `/settings/secrets` has "Passwords and keys". `desktop-5.png`, `desktop-5b.png`.
- The page works for the admin. It shows the same three rows (`desktop-5c.png`). The admin added `Bearer admin123` and the row turned Signed in with Replace and Disconnect (`desktop-5d.png`). Disconnect brought back "Not signed in" and the notice (`desktop-5e.png`).
- Phone: the nav becomes wrapped chips with "Your sign-ins" first. Group labels are hidden below md, as the existing layout does. The Apps and Passwords and keys headings are correct and nothing scrolls sideways. `phone-5.png`, `phone-5b.png`, `phone-5c.png`.

### 6. Phone layout

- On `/settings/sign-ins`, `scrollWidth` equals `clientWidth` (390) and no element in `main` extends past 391px. Forcing `scrollTo(500,0)` leaves `scrollX` at 0. Each row renders as a card with Name, Status and actions. The action buttons are 40px tall (Add sign-in 86x40, Connect 69x40). The paste dialog fits the screen and its Save button spans the full width. `phone-6.png` (full page). Desktop reference: `desktop-6.png`.

## Console and network

- No console errors in any flow except the Not counted items below. Every page logged the same benign lines: the Vite connect debug messages, the React DevTools info line and Clerk's "loaded with development keys" warning.
- No 4xx or 5xx on any request the KY.6 flows made: the `connectors.mine` loader, `connectors.setCredential` and `connectors.removeCredential`.

Not counted (caused by my fake seed hosts):

- `GET /connect/<oauth id>…` returned 500 twice, once in flow 4 at each size, because `oauth.example.com` does not resolve.
- An earlier `connectors.setCredential` returned 400 during setup, before I pointed Header Test App at a reachable server. The dialog showed "Could not read the tool list from that server."

## Observations (not failures of the KY.6 check)

1. Members see the whole admin settings nav. On `/settings/sign-ins` a member sees Model providers, Machines, Apps, Passwords and keys, Artifacts, API keys, Connected apps and Agent connections. Find lists those entries for members too. A member who opens `/settings/connectors` gets the full admin table with Paste credential, Auth, Time limit, Delete, Connect and Set client controls (`desktop-2d.png`). I did not test whether the server refuses those mutations for a member. Before KY.6 members had no settings entry point, so the new page makes this more visible. The nav could hide admin groups for members.
2. "Apps" now names three things. The rail tab "Apps" and Find's "What agents use > Apps" (hint Artifacts, `/artifacts?kind=app`) both point at artifacts, while Find's "Settings > Apps" (hint Connectors) points at the connectors page. Searching "apps" in Find shows two plain "Apps" rows (`desktop-2c.png`).
3. Phone card layout: the Name cell puts the app name and its URL side by side, so the name wraps right-aligned ("Header Test / App") next to a long monospace URL (`phone-3c.png`). The card is readable but cramped.
4. The `/connect/<id>` handler shows a bare 500 page when the provider cannot be reached, instead of a refusal page that links back to `return_to`. This is older code, not part of KY.6.
5. The Connect link's accessible name is just "Connect". Disconnect has `aria-label="Disconnect <app>"`, but Connect does not, so a screen reader cannot tell several Connect links apart.

## Cleanup state

- The local D1 still holds the three seeded connectors, with Header Test App pointing at `https://mcp.deepwiki.com/mcp`. It holds no credentials.
- The Clerk dev user `dev+ky6member@harbouredgeintelligence.ai` remains an org:member of Dev Workspace.
