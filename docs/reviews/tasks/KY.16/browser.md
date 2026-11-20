Verdict: pass

Commit 2f8e370b, `vite dev` on port 3161, headless Chromium via agent-browser (sessions ky16-admin and ky16-member). Admin = DEV_LOGIN_EMAIL user (org:admin, dev login). Member = dev+member@harbouredgeintelligence.ai, an `org:member` of the same "Dev Workspace" organisation (read from Clerk's membership list), so no role blocker. No Clerk users were created and no routing token was set (CF_EMAIL_ROUTING_TOKEN stayed blank).

Caveats, read before trusting "pass":
- Test data: two stub active agents (KY16 Stub A used for desktop, KY16 Stub B for phone), inserted by SQL, `created_by` = admin, `owner_user_id` NULL, no address, no mailbox. Using a separate agent per size gave each size its own unreserved start.
- With the routing token blank, "Reserve" also writes an `agent_mailboxes` row with status `provisioning` (last_error "Provisioning pending: Cloudflare Email Routing is not configured yet"). With that row present, the header shows "Setting up" plus "Try again" (the provisioning label in `mailProvisionLabel`), and the Keys tab Email section shows only the address with no button, because the Keys tab offers its button only when there is no mailbox row (existing behaviour, not changed by this task). To see "Set up mail" in the header and the Email button on Keys I deleted the mailbox row by SQL, as the brief allowed ("or reset"). Clicking "Set up mail" then called `mailbox.provision` (HTTP 200) and the page went back to "Setting up" / "Try again" with nothing real configured. I did not capture a toast.
- Console 400 on the admin session: one "Failed to load resource 400 ()" appeared during the desktop admin run. I could not reproduce it (reloading /home and the agent page afterwards gave zero console errors, and no resource entry had responseStatus 400 or above). KY.14's report saw the same line on the first load after dev sign-in, so I treat it as that, not this feature. Phone admin run: zero console errors.
- The member sessions' console shows 400 and 403 lines. They come from my own flow C calls: my first probe was malformed (tRPC input wrapped in `json`, this app has no transformer) and answered 400 BAD_REQUEST, and the real calls answered 403. All expected.
- agent-browser has no per-request status log, so statuses come from `performance.getEntriesByType("resource")` (responseStatus) and a fetch wrapper on the admin Set up mail click.

## Flow A, owner/admin
Desktop (1280x800), Stub A:
- Opened the agent room. Header shows the "Reserve an address" chip button. desktop-1.
- Clicked it, typed ky16-check, clicked Reserve. Toast "Address reserved". The header shows the address chip ky16-check@agents.rockyshoreslabs.io, "Setting up" and "Try again". desktop-4.
- Removed the mailbox row by SQL (see caveats) and reloaded. Header shows the short chip "ky16-check@" and a "Set up mail" button. desktop-5. The Keys tab, "Its own identity": "No email address yet." with a full-width "Set up mail" (Email) button, and no "Only the agent's owners and admins" email note. desktop-6.
- Clicked the header "Set up mail": `mailbox.provision` answered 200, the header went to address chip, "Setting up", "Try again". desktop-7. Keys then shows the address with no button (mailbox row exists).
Phone (390x844), Stub B:
- Header "Reserve an address". phone-1. Reserved ky16-phone, header shows the address chip, "Setting up", "Try again". phone-4.
- Removed the mailbox row, reloaded: header "Set up mail" (phone-5), Keys tab Email section with the "Set up mail" button and no note (phone-6). Clicked the Keys button: header went to chip plus "Try again" (phone-7). scrollWidth 390, no overflow.

## Flow B, plain member
Desktop, Stub A (same agent):
- Before the reserve: header shows a static dashed "No address yet" chip, no Reserve, Set up mail, Retry or Try again control (Edit and Run now remain). desktop-2. Keys tab: Email says "No email address yet." followed by "Only the agent's owners and admins can set up its email."; no Email button. Snapshot found 0 reserve/set-up/retry/try-again controls. desktop-3.
- After the admin reserved: header shows the address chip ky16-check@agents.rockyshoreslabs.io and no "Set up mail" or "Try again". desktop-8. Keys shows the address, the same note, no button. desktop-9.
Phone, Stub B:
- Before: "No address yet" chip, no controls. phone-2. Keys: note shown, no button, 0 controls. phone-3.
- After: address chip ky16-phone@agents.rockyshoreslabs.io, no Set up mail or Try again (phone-8); Keys shows address plus note, no button (phone-9). scrollWidth 390.

## Flow C, member API refusal
As the member, from the page, a fetch POST to /api/trpc/agents.reserveAddress (local ky16-hack) and /api/trpc/mailbox.provision for the admin's agent, on Stub A at desktop size and on Stub B at phone size. All four answered HTTP 403 code FORBIDDEN ("Not allowed: agents.update" and "Not allowed: mail.manage"). This is the expected refusal. Afterwards D1 showed email_local NULL on both agents (ky16-hack never set) and zero `agent_mailboxes` rows; after the admin's reserve the values were ky16-check and ky16-phone. No screenshot (API calls).

## Console and network
- Admin desktop: one unattributed 400 (see caveats), otherwise Clerk dev-keys warning, React devtools and Vite info only. No resource entry with status 400 or above; all /api/trpc calls 200 including mailbox.provision.
- Admin phone: zero console errors, zero failed resources.
- Member desktop and phone: no failed resources on the room pages. Console errors only the expected 403s from flow C (and the 400 from my malformed probe).

## Cleanup
Both browser sessions closed, dev server (PID I started) stopped. Local D1: deleted both stub agents, their sessions, mail triggers, mailbox rows and the two append-only `agent.address_reserved` events (which block the agent delete through a foreign key). To delete the events I dropped the local `events_no_delete` trigger and recreated it with its identical original SQL, then confirmed it exists. `agents`, `sessions`, `triggers`, `agent_mailboxes` and `events` are all at 0 rows. No source files or `.env.local` changed; git shows only the new docs/reviews/tasks/KY.16/ folder.
