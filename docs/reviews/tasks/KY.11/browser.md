# KY.11 browser check

Verdict: pass

Run: vite dev on port 5411 (local D1), dev login, agent-browser session `ky11-verify`, Chromium headless shell. Sizes 1280x800 and 390x844.

Setup notes: local data was empty. Agent creation needed a runtime, so one machine row ("dev-box", offline) was inserted into the local D1 with sqlite3, then the agent "KY11 Tester" was made through Start blank. Trying a fake Anthropic key in Settings, Model providers returned "Anthropic did not accept that key", which is the one HTTP 400 in the desktop console. It is setup noise, not part of the flows.

## Desktop (1280x800)

Flow 1. Keys tab, Add an app, chose Gmail, Add app. Keys row showed "5 tools" (desktop-1 is the Keys tab before the add). Opened "Allowed tools" (desktop-2): dialog listed all 5 catalogue defaults (get_message, get_thread, list_drafts, list_labels, search_threads) each with a Remove button, Save disabled until a change. Removed list_drafts (desktop-3), Save. Dialog closed, row read "4 tools" (desktop-4). Reopened (desktop-5): 4 names, list_drafts gone. Pass.

Flow 2. Settings, Apps (desktop-7): Gmail Tools column shows "5 by default" and "Tool list not fetched yet" plus the default names. 5 equals the catalogue default count. Pass.

Flow 3 (optional). Removed all names (desktop-6): text "No names left. Saving allows every tool." and the button reads "Allow every tool". Closed without saving. Pass.

## Phone (390x844)

Flow 1. Keys row "4 tools" (phone-1). Dialog lists the 4 saved names, so the desktop save persisted (phone-2). Removed list_labels (phone-3), Save, row "3 tools" (phone-4). Reopened: 3 names (phone-5). Pass. Dialog fits the screen, no horizontal scroll.

Flow 2. Settings, Apps (phone-7): "5 by default", "Tool list not fetched yet". Pass.

Flow 3. All names removed (phone-6): warning text and "Allow every tool" button shown; closed without saving. Pass.

Screenshot index: desktop-1 Keys tab (flow 1), desktop-2 dialog with 5 names (1), desktop-3 after removing one (1), desktop-4 row at 4 tools (1), desktop-5 reopened dialog (1), desktop-6 empty dialog (3), desktop-7 Settings Apps (2). phone-1 to phone-7 follow the same order for phone (phone-1 Keys row, phone-2 dialog, phone-3 after remove, phone-4 row at 3 tools, phone-5 reopened, phone-6 empty dialog, phone-7 Settings Apps).

## Console and network

Desktop console: only vite/React DevTools/Clerk dev-key info and warnings, a WebGL software fallback warning, and one 400 (Anthropic key attempt during setup, see above). Phone console was cleared before the walk and showed no errors; network log had no 4xx/5xx. No feature-related errors or failed requests at either size.
