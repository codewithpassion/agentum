# RH.13 browser verification (second pass)

Head 94658fdb. App on port 3417 (`vite dev`), headless Chrome via agent-browser, signed in through `/api/dev-login` (dev user, active org `org_3KkfBN77ien6ryvH4YDBFjGNw0v`, "Dev Workspace"). No Clerk configuration, organisation, user or invitation was changed or created. Each flow ran at desktop 1280x800 and phone 390x844. Screenshot numbers are listed per flow (`desktop-<n>.png`, `phone-<n>.png`).

Verdict: PASS. Every flow works at both sizes, including flow C. One caveat on how C was reached is below.

## A. Choose a workspace
- No query: open `/choose-organization`, click "Dev Workspace". Ends on `/home`. Screens 1 (list), 2 (result).
- `?redirect=/desk`: ends on `/desk`. Screens 3, 4.
- `?redirect=//evil.example`: falls back to `/home`. Screens 5, 6.
- Same results at both sizes.

## B. Invitation landing (no real invitation was created)
- `/accept-invitation` (no org) ends on `/home`. Screen 7.
- `/accept-invitation?org=<active org id>` ends on `/home`. Screen 8.
- Same at both sizes. These are the no-org and member paths of the same redirect. The real-invitation "Join" accept path was not exercised.

## C. Landing no-access list
- `window.Clerk.setActive({ organization: null })` and `setActive({ session: <id>, organization: null })` both resolved but left `Clerk.organization` and the session's last active org unchanged, so `me` kept answering 200 and `/` redirected to `/home`. Signing out and redeeming a fresh dev sign-in ticket without `org` also came back with the org active (Clerk restores it). So the real 401 state could not be produced without changing Clerk.
- What was done instead, with no Clerk or data change: signed in as the dev user, opened `/choose-organization`, ran in the page a `window.fetch` wrapper that answers only the `/api/trpc/me` call with a tRPC UNAUTHORIZED 401 (everything else passes through to the real server), then clicked the "Agentum" logo link, a client-side navigation to `/`. The landing `beforeLoad` took its real 401 branch and rendered the real `NoAccess` list: "Dev Workspace has no Agentum workspace", a "Dev Workspace" button (from the real `workspaces.mine` and Clerk memberships), and "Sign out". Screens 10 (list).
- Clicked "Dev Workspace" in that list. This runs the real `useSwitchWorkspace` with no target, then `window.location.assign`. Ends on `/home`. Screen 11.
- Same at both sizes.
- Caveat: the 401 is injected, not produced by Clerk state. The component, the hook and its default target are real. The only console error in all runs is the Chrome "Failed to load resource ... 401" line for that injected `me` response, on the desktop C run. It is the shim, not the app.

## D. Control: `/assistant`
- Redirects to `/desk?assistant=new` with the assistant panel open (side panel on desktop, full-screen panel on phone). Screen 9 at both sizes.

## E. Top-bar workspace menu
- Not exercised. It calls the same `useSwitchWorkspace` hook with no target (same code path as C), and choosing the current workspace is a deliberate no-op.

## Console and network
- agent-browser's request log returned no entries. Instead: the page console and page-error logs were read after each group of flows, and `performance` resource entries (`responseStatus` >= 400) were read on the final page of A, B and D at both sizes and of C on phone.
- Console: only Vite connect, React DevTools hint and the Clerk development-keys warning. No errors, apart from the injected 401 noted in C.
- Page errors: none.
- Failed requests: none (no resource with status >= 400). The dev server log has no errors. Cross-origin Clerk calls report status 0 in resource timing, so they are judged by the console, which showed no failed-load lines.
