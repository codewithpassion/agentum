# SL.7 browser check

Setup: migration 0061 applied locally; `bunx vite dev --port 5871` (PID 2603896, parent bunx 2603895, both stopped at the end); signed in via `/api/dev-login` (agent-browser session `sl7`). Seeded in local D1 under team "Everyone": topic `thr_sl7` (no member limits), a member post by the dev user (`author_kind` user, `guest_name` NULL), a guest post (`slack:T0TEAM:U0GUEST`, `guest_name` "Priya Sharma", text "can we move the call to Friday?"), and a multi-line guest post with a long URL. The member post is authored by the dev user, so it renders as "You".

## Flow: open team room topic (/teams/<id>/room?topic=thr_sl7)

### Desktop 1280x800 (desktop-1.png)
Steps: open the topic URL, read the post list, screenshot, measure overflow with eval.
Saw: member post shows "You" with no tag. Guest posts show "Priya Sharma", a "Slack guest" tag, and only the message text, no "(Slack guest):" prefix (page text contains no "(Slack guest)"). The multi-line post keeps its line breaks. No horizontal overflow (scrollWidth 1280 = clientWidth 1280, no post element overflows).
Console/network: no console errors (only the Clerk dev-keys warning), no 4xx/5xx responses, no server-side errors in dev.log on a clean reload.

### Phone 390x844 (phone-1.png)
Same steps at 390x844.
Saw: same content and tags. Long text and the unbroken URL wrap or fit inside the column; scrollWidth 390 = clientWidth 390, no post overflows.
Console/network: same as desktop, clean.

## Note on earlier errors
My first pass logged one 400 and two 500s in the console. The 500s were `spend.workspace` and `desk.rail` hitting `SQLITE_BUSY` while my own `wrangler d1 execute` seeding held the local DB (see dev.log); the 400 came during the dev-login sign-in. After seeding, fresh reloads at both sizes (console cleared first) produced none, and the resource timing log showed no response >= 400. Not caused by SL.7.

## Verdict: pass
