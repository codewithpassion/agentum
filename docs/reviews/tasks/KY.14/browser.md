Verdict: pass

Commit 9906fbca, `vite dev` on port 3114, headless Chromium via agent-browser. Admin = dev@rockyshoreslabs.io (org:admin). Member = dev+member@harbouredgeintelligence.ai, confirmed `org:member` in the same "Dev Workspace" organisation (read from Clerk's membership list), so it sees the admin's secrets. No admin-role blocker.

Caveats, read before trusting "pass":
- Two console 400s appeared, neither from a feature defect. (1) Phone admin run: one "Failed to load resource 400" after my scripted Edit hosts retries. I reproduced the same console line by saving the hosts field with an invalid value ("bad host !! x"), where the server answers BAD_REQUEST "A host is a domain such as api.example.com...". That is correct validation, and I could not reproduce the 400 with valid input (create, replace, hosts unchanged, mode, delete, rules all clean with a fetch hook). (2) Member's first load of /home after sign-in logged one "400 ()" resource error. It is not on /settings/secrets, and the member's secrets page and agent page runs were clean.
- Flow C: the local DB had no agent and creating one needs an Anthropic key or a machine. I inserted one stub row (`ky14-verify-agent`) with SQL, opened its Keys tab, and deleted the row and its auto-created session afterwards. The Keys tab in this build shows Apps, identity, hands-to, ask level. I did not see a secrets-grant list there (the VERIFY secrets were not listed), so grant behaviour was not exercised, only that the tab loads.
- agent-browser's request log has no status codes. I checked failures with `performance.getEntriesByType("resource")` (responseStatus) and a fetch wrapper. No 4xx/5xx other than the two above.

Screenshot numbering is stable per flow step (desktop-N at 1280x800, phone-N at 390x844).

## Flow A, admin (desktop)
Steps and shots: desktop-1 page with no "only an admin" note and an empty list. desktop-2 New secret dialog (Env, VERIFY_ENV_KEY, value verify-value-0123, host api.example.com). desktop-3 list after create. desktop-4 proxy dialog (VERIFY_PROXY_KEY, api.example.com, Authorization, `Bearer {value}`). desktop-5 list with both. desktop-6 Replace value dialog, saved. desktop-7 Edit hosts (added other.example.com), list updated. desktop-8 Edit rules (added a second rule second.example.com / X-Api-Key), list updated. desktop-9 and desktop-10 Change mode dialog (env secret, rules prefilled from hosts), desktop-11 list shows VERIFY_ENV_KEY now proxy. desktop-12 Delete confirm ("Delete VERIFY_ENV_KEY? ... every agent loses this secret."), desktop-13 after delete.
Saw: every dialog opened and saved, list updated each time, no value shown anywhere. Console: only Clerk dev-keys warning and Vite messages. No failed requests.

## Flow A, admin (phone)
phone-1 page. phone-2 Delete confirm, deleted the existing proxy secret. phone-3/4 create VERIFY_ENV_KEY. phone-5/6 create VERIFY_PROXY_KEY. phone-7 Replace value. phone-8 Edit hosts. phone-9 Edit rules (second rule added, saved). phone-10 Change mode (env to proxy, saved; later switched back to env once more while testing). No horizontal overflow (scrollWidth 390). Console and network: the 400 described above (invalid-input test), nothing else.

## Flow B, member
Desktop: desktop-14. The note "Only an admin can add, change or delete secrets. Ask an admin to do it, or grant an existing secret to your agent on its Keys tab." is visible. The list is readable (both rows, mode and hosts). New secret, and for both rows Replace value, Edit hosts or Edit rules, Change mode, Delete all have `disabled` true (snapshot and DOM). Clicking New secret and Delete timed out as not actionable and no dialog opened (0 dialogs).
Phone: phone-11. Same note, same list as stacked rows, all buttons disabled, no overflow.
Console and network on /settings/secrets (desktop and phone): clean.

## Flow C, member on an agent's Keys tab (stub agent, see caveats)
Desktop desktop-15 and phone phone-12 (Keys tab). The tab loaded without error. phone-13 is the Knows tab, which holds the "Passwords and keys" memory rule, unrelated to secrets. Console and failed-request check: clean.

## Cleanup
VERIFY_ENV_KEY and VERIFY_PROXY_KEY deleted as admin (list shows "No secrets yet"). Stub agent and its session and mailbox rows removed from the local D1. `apps/web/.env.local` restored byte for byte (diff identical). Dev servers I started are stopped and both browser sessions closed.
