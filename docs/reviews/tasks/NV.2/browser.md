# NV.2 browser verification (round 2)

Verifier: independent browser check, agent-browser session `nv2-verify2`, headless Chromium.
Build: worktree `/home/roboto/devel/harbourmaster-wt/NV.2`, branch `task/NV.2-plain-runtime-words` (96043a36 plus docs).
Server: `bunx vite dev --port 5193` from `apps/web`, after `wrangler d1 migrations apply DB --local` (no migrations pending).
Data: local D1 with machine `studio-nuc` (agent_host, shown Online) and the Anthropic key set by the earlier round.

## Sign-in

The browser profile still held a Clerk session from the earlier round, so `/login` showed "You're signed in as dev@rockyshoreslabs.io" and no "Dev login (local only)" link. I opened the link's target, `/api/dev-login`, directly. It redirected to `/dev-login?token=…` and then to `/desk` with a fresh session.

## Desktop (1280x800)

### Cloud agent `nv2-cloud-d`

1. Start blank: the Runs on chips read "Anthropic cloud", "Cloud", "My computer: studio-nuc". No "Cloudflare" or "Our machine" anywhere on the page (desktop-1). Filled the name and "What it does", picked Cloud (aria-pressed true), clicked Create agent without opening any Advanced section (desktop-2). The agent was created and the page went to its profile, with the header badge "Runs on Cloud".
2. Profile: the Runs on card shows "Cloud", "Always on, lowest cost for many small jobs.", Move agent, Advanced (desktop-3).
3. Edit form, from the card's Advanced button: Model select (friendly names), Runtime "Runs on Cloud". Environment, Network access and Turn limit are not shown while the form's Advanced is closed (desktop-4). Opening Advanced shows Environment (Isolate / Linux VM), Network access and Turn limit (desktop-5). Set Turn limit to 120, saved, and the "Saved" toast appeared (desktop-6). `agents.update` returned 200.
4. Move agent: the Move to options are "Anthropic cloud" and "My computer", with Cloud left out (desktop-7). Selecting My computer adds the Machine select (studio-nuc) and the line "The agent's computer is detached." (desktop-8). Selecting Anthropic cloud shows only the standard text. Cancel closed the dialog, and the agent still runs on Cloud.

### Anthropic cloud agent `nv2-managed-d`

1. Start blank: picked Anthropic cloud (aria-pressed true) (desktop-9). Created. Header badge "Runs on Anthropic cloud".
2. Runs on card: "Anthropic cloud", "Managed Agents. Simplest. Has its own sandbox." (desktop-10).
3. Edit form: Runtime "Runs on Anthropic cloud". With Advanced closed, no Model field is visible and the raw model id is hidden (desktop-11). Opening Advanced shows the Model textbox `claude-sonnet-5-5` with "Use opus, sonnet or haiku." (desktop-12). Changed it to `claude-haiku-5-5`, saved, and "Saved" appeared (desktop-13).
4. Move agent: the options are "Cloud" and "My computer" (desktop-14). Cloud adds "A conversation that ran on Cloud before may pick up there, without what happened since." My computer adds the Machine select and "The agent's computer is detached." Cancel, and the agent still runs on Anthropic cloud.

### My computer agent `nv2-machine-d`

1. Start blank: picked "My computer: studio-nuc" (aria-pressed true) (desktop-15). Created. Header badge "Runs on My computer: studio-nuc".
2. Runs on card: "My computer: studio-nuc" with an "Online" badge, "Claude Code on that machine. Sees local files." (desktop-16).
3. Edit form: Runtime "Runs on My computer: studio-nuc". The Machine select ("studio-nuc (online)") stays visible outside Advanced. With Advanced closed, the model id and Turn limit are hidden (desktop-17). Opening Advanced shows the Model textbox (`claude-sonnet-5-5`) and Turn limit (desktop-18). Set Turn limit to 150, saved, and "Saved" appeared (desktop-19).
4. Move agent: the options are "Cloud", "Anthropic cloud" and "My computer". My computer is kept for a machine agent, as the spec requires (desktop-20). Each option showed the text described above. Cancel, and the agent is unchanged.

## Phone (390x844)

Same steps, same results.

- `nv2-cloud-p`: chips wrap to two lines and all three read correctly (phone-1). Created, and the card reads "Cloud" (phone-2). With Advanced closed the form has Model and "Runs on Cloud" (phone-3). Open, it shows Environment, Network access and Turn limit (phone-4). Turned Network access off, set Turn limit to 120, saved, and "Saved" appeared (phone-5). Move to offered Anthropic cloud and My computer. Cancel (phone-6).
- `nv2-managed-p`: chip selected (phone-7). The card reads "Anthropic cloud" (phone-8). Closed form: "Runs on Anthropic cloud", no model id (phone-9). Open: Model `claude-sonnet-5-5` (phone-10). Changed it to `claude-haiku-5-5`, and "Saved" appeared (phone-11). Move to offered Cloud and My computer. Cancel (phone-12).
- `nv2-machine-p`: chip selected (phone-13). The card reads "My computer: studio-nuc", Online (phone-14). Closed form: "Runs on My computer: studio-nuc", Machine select visible, no model id or Turn limit (phone-15). Open: Model and Turn limit (phone-16). Set Turn limit to 150, and "Saved" appeared (phone-17). After a reload, the Turn limit field holds 150. Move to offered Cloud, Anthropic cloud and My computer. Cancel (phone-18).

After the phone pass, I searched the Start blank page and a profile page for "Cloudflare" and "Our machine". Neither word appears.

## Console and network

Real errors: none. `agent-browser errors` was empty after every flow. A fetch hook plus Resource Timing captured every tRPC request in each flow, including `agentBuilder.saveDraft`, `agentBuilder.create`, `agents.update`, `machines.list`, `agents.providerKeys` and the Clerk token refresh. All returned 200. No request failed, and no resource returned 4xx or 5xx.

Dev noise, not counted:
- `[vite] connecting…` / `[vite] connected.` is the Vite HMR client.
- "Download the React DevTools…" is a React dev-build notice.
- "Clerk has been loaded with development keys" is from the Clerk dev instance.
- "Automatic fallback to software WebGL has been deprecated" and "No available adapters." appeared only on the public `/login` page. They come from its canvas in headless Chromium, which has no GPU, and are not part of the NV.2 flows.

`networkidle` never settles under Vite because the HMR socket stays open, so I used fixed waits instead.

## Observations (non-blocking)

- The Anthropic cloud card's description still says "Managed Agents. Simplest. Has its own sandbox." The label is plain, but the blurb uses the product term. The spec only names the labels.
- Choosing "My computer" in the Move dialog for an agent already on My computer still shows "The agent's computer is detached." That is existing dialog copy and outside this task.
- `snapshot -i` gave no ref to the "My computer: studio-nuc" chip, although the full accessibility tree lists it as a button and clicking it works. This is a tooling quirk, not an app fault.

## Verdict

**Pass.** Every flow (Start blank create, Runs on card, Edit form with the Advanced disclosure closed and open plus a save, Move dialog names) works for all three runtimes at 1280x800 and at 390x844. There were no console errors and no failed requests. I moved no agents and changed no source files.
