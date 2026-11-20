# KY.12 browser verification

Commit b0b0f540, run from the worktree with `vite dev --port 3412`, agent-browser session `ky12-verify`, headless shell. Sizes: desktop 1280x800, phone 390x844.

Setup notes
- Signed in through `/api/dev-login`. The dev user is an admin: the "Add from the catalogue" picker rendered on Settings, Apps.
- The local workspace had no agent. Creating one in the UI was blocked (no model provider; a fake Anthropic key was rejected with a 400, which is the one `Bad Request` console error in the session). I inserted one agent row (runtime `fake`, "Verify Bot") into the local D1 only. No source files changed.
- Between sizes I deleted Linear from the Apps table (Delete, then confirm) so the add could run again. See `phone-0-before-delete.png`.
- "Failed requests": agent-browser does not log statuses. On desktop I relied on browser console errors (the browser logs every 4xx/5xx there). On phone I also wrapped `fetch` and recorded non-OK responses.

## Flow 1: Settings, Apps, admin adds Linear (desktop)
1. Open /settings/connectors. Picker "App to add" with "Add app" (disabled until chosen) shows under "Add from the catalogue". Options: Gmail, Linear, Notion, Slack, Cloudflare Docs. Page says "No connectors yet." `desktop-1.png`
2. Choose Linear. `desktop-2.png`
3. Click Add app. Message "Added Linear." Linear appears as a row in the Apps table (OAuth forced, needs auth, 4 tools by default, 60 s). Picker options now: Gmail, Notion, Slack, Cloudflare Docs (no Linear). `desktop-3.png`
Result: pass.

## Flow 2: Keys tab shows Linear under "Already in this workspace" (desktop)
1. Open the agent, Keys tab. The "Add an app" select has optgroups "From the catalogue" (Gmail, Notion, Slack, Cloudflare Docs) and "Already in this workspace" (Linear). `desktop-4.png` (native select is closed in the screenshot; groups read from the DOM)
Result: pass.

## Flow 3: Keys tab still adds a catalogue app (desktop)
1. Choose Notion, click Add app. Notion appears under "Apps it can use" (Needs sign-in, 2 tools). Select now: From the catalogue = Gmail, Slack, Cloudflare Docs; Already in this workspace = Linear. `desktop-5.png`
Result: pass.

## Flow 1 (phone): Settings, Apps add
1. After deleting Linear, Apps shows only Notion. Picker row fits (select 16-188 px, button 196-270 px, 32 px tall). Options: Gmail, Linear, Slack, Cloudflare Docs. scrollWidth 390 = clientWidth 390. `phone-1.png`
2. Choose Linear. `phone-2.png`
3. Add app. "Added Linear." Linear row appears in the Apps list (rows stack as cards); picker no longer offers Linear. No horizontal overflow. `phone-3.png`
Result: pass.

## Flow 2 (phone): Keys tab "Already in this workspace"
1. Agent Keys tab (`?tab=keys`). Groups: From the catalogue = Gmail, Slack, Cloudflare Docs; Already in this workspace = Linear. No overflow (390/390). `phone-4.png`
Result: pass.

## Flow 3 (phone): add catalogue app from Keys tab
1. Choose Gmail, Add app. Gmail appears under "Apps it can use". Groups now: From the catalogue = Slack, Cloudflare Docs; Already in this workspace = Linear. `phone-5.png`
Result: pass.

## Console and network
- Console: only a Clerk dev-keys warning and Vite/React info lines. One `400 Bad Request` "Failed to load resource" error, caused by my rejected fake Anthropic key on the Model providers page (setup, outside the flows). An earlier `400 ()` line showed once right after the dev-login redirect (Clerk sign-in, before any flow). Neither occurred during the flows above.
- Phone fetch monitor: no non-OK responses during the add and Keys flows. No uncaught page errors. Dev server log showed no errors.
- Limitation: desktop network status was not logged per request; only the console was checked there.

## Verdict
PASS. Every flow worked at both sizes, with no console errors or failed requests inside the flows.
