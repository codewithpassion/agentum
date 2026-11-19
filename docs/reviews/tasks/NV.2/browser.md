# NV.2 browser verification

Verifier: independent browser check, not the builder.
Branch: `task/NV.2-plain-runtime-words` at `89a6d11e`, worktree `/home/roboto/devel/harbourmaster-wt/NV.2`.
App: `bunx vite dev --port 5192` from `apps/web` after `wrangler d1 migrations apply DB --local`. Signed in with "Dev login (local only)" on `/login`. Browser: agent-browser session `nv2-verify`, headless Chromium. Desktop is 1280x800, phone is 390x844.

## Setup note

On the first visit to Start blank, "Runs on" offered no choice: "No runtime is available. Add a provider key or a machine in Settings." (that page was captured before the setup below, and the file was later overwritten). I set the workspace Anthropic API key in the app UI at Settings > Model providers, using the key in `apps/web/.env.local`. After that, Start blank offered "Anthropic cloud" and "Cloudflare". No machine is registered, so no agent could be created on "My computer".

I tested two agents at each size: one on Cloud (`cloud`) and one on Anthropic cloud (`managed`). The cloud agent covers Environment, Network access and Turn limit. The managed agent covers the raw model id and lists "Cloud" as a Move to choice. Agents created: NV2 Desk Agent (cloud, twice, because the first run was repeated to capture network data), NV2 Managed Agent (managed) and NV2 Phone Agent (cloud). The phone pass used NV2 Managed Agent again for flows 2 to 4.

## How console and network were read

`agent-browser network requests` captured nothing in this setup. Instead, after each page load I wrapped `window.fetch` to record each request's status, raised the resource-timing buffer, and listed every resource entry with a status of 400 or more. I read the console and page errors with `agent-browser console` and `agent-browser errors` after each flow, and I checked the vite server log.

## Desktop (1280x800)

### Flow 1: create with Start blank (cloud)
On /agents/new I clicked "Start blank", filled Name "NV2 Desk Agent" and What it does, and picked "Cloudflare" under Runs on. The Start blank page has no Advanced section, so none was opened. Clicking "Create agent" led to `/agents/01M7TTDZ2KG1T6X0BV6CXPAD52`. Requests `agentBuilder.saveDraft` and `agentBuilder.create` both returned 200. Screenshot: desktop-1.png (form filled, Cloudflare picked).

### Flow 2: Runs on card (cloud)
The header chip reads "Runs on Cloud". The card reads "Runs on / Cloud / Always on, lowest cost for many small jobs." with "Move agent" and "Advanced" buttons. Neither "Cloudflare" nor "Our machine" appears anywhere on the profile page. Clicking the card's "Advanced" opened the "Edit agent" sheet. Screenshot: desktop-2.png.

### Flow 3: Edit form (cloud)
The Runtime line reads "Runs on Cloud". While the form's Advanced disclosure was closed, the sheet had no Environment select, no Network access switch and no Turn limit field. The word "Environment" did appear once, inside the runtime help text ("the Environment setting under Advanced"). After I opened Advanced, the sheet showed Environment (Isolate / Linux VM), Network access (on) and Turn limit. I set Turn limit to 120 and clicked "Save changes". `agents.update` returned 200, and a "Saved" toast appeared. Screenshots: desktop-3.png (Advanced closed), desktop-4.png (Advanced open, 120 entered), desktop-5.png (Saved).

### Flow 4: Move agent (cloud)
Move to offered "Anthropic cloud" and "My computer". The dialog leaves out the agent's current runtime, so "Cloud" is not listed for a cloud agent. I clicked Cancel, the dialog closed, and the agent still runs on Cloud. Screenshot: desktop-6.png.

### Second agent on Anthropic cloud (flows 1 to 4)
Start blank with "Anthropic cloud" created NV2 Managed Agent (`/agents/01M7TTFZ4A0KND8VYMNN7ANDDH`). Its Runs on card reads "Anthropic cloud". The Edit sheet's Runtime line reads "Runs on Anthropic cloud". With Advanced closed, the sheet showed no model id. After I opened Advanced, it showed a Model textbox holding `claude-sonnet-5-5`. A managed agent has no Turn limit field, which matches "where applicable" in the brief. I changed the model to `claude-haiku-4-5` and saved. `agents.update` returned 200 and "Saved" appeared. Move to offered "Cloud" and "My computer". I cancelled without moving. Screenshots: desktop-7.png (Start blank, Anthropic cloud picked), desktop-8.png (profile), desktop-9.png (Advanced open, model id edited), desktop-10.png (Saved), desktop-11.png (Move to: Cloud, My computer).

## Phone (390x844)

### Flow 1: create with Start blank (cloud)
Same steps, with name "NV2 Phone Agent" and "Cloudflare" picked. The form fits the width, and "Create agent" led to `/agents/01M7TTHPJ3H3QRVR076FVR19HQ`. `agentBuilder.create` returned 200. Screenshot: phone-1.png.

### Flow 2: Runs on card (cloud)
The card reads "Runs on / Cloud / Always on, lowest cost for many small jobs." and stacks below the main column. The card's "Advanced" opened the Edit sheet. Screenshot: phone-2.png.

### Flow 3: Edit form (cloud)
The Runtime line reads "Runs on Cloud". With Advanced closed, the sheet had no Network access switch, no Turn limit field and no Environment select. After I opened Advanced, it showed Environment, Network access and Turn limit. I switched Network access off and saved. `agents.update` returned 200, and "Saved" appeared. Screenshots: phone-3.png (Advanced closed), phone-4.png (Advanced open, switch off), phone-5.png (Saved).

### Flow 4: Move agent (cloud)
Move to offered "Anthropic cloud" and "My computer". I cancelled, and the agent still runs on Cloud. Screenshot: phone-6.png.

### Anthropic cloud agent (flows 2 to 4)
The card reads "Anthropic cloud". The Edit sheet's Runtime line reads "Runs on Anthropic cloud". With Advanced closed, no model id showed. After I opened Advanced, the Model textbox showed `claude-haiku-4-5`, which confirms the desktop save persisted. I changed it back to `claude-sonnet-5-5` and saved. `agents.update` returned 200 and "Saved" appeared. Move to offered "Cloud" and "My computer". I cancelled. Screenshots: phone-7.png (card), phone-8.png (Advanced, model id), phone-9.png (Saved), phone-10.png (Move to: Cloud).

## Console and network

There were no console errors and no page errors in any flow at either size. Every recorded fetch returned 200, and no resource returned 400 or more. The vite log shows no server errors.

Noise only (dev-only, not errors):
- `[warning] Clerk: Clerk has been loaded with development keys` comes from the dev Clerk instance.
- `[info] Download the React DevTools` is printed by React in dev builds.
- `[debug] [vite] connecting... / connected.` comes from HMR.

## Findings outside the scoped files

1. The Start blank "Runs on" picker still labels `cloud` as **"Cloudflare"** (`apps/web/src/components/agent/builder/builder-logic.ts:160`, used by `start-blank.tsx` and `draft-card.tsx`). This is the very flow named in the Check line. A user picks "Cloudflare" on create, and the profile then says "Cloud". The spec's Scope lists only agent-form, runs-on-card and move-agent-dialog, so this is not a broken requirement. It does work against the milestone's aim that a business user sees three plain names. A one-line follow-up should fix it.
2. Settings > Model providers still says "Cloudflare agents and Managed Agents both run on your workspace's own Anthropic API key." This is outside NV.2 scope.
3. The Anthropic cloud card says "Managed Agents. Simplest. Has its own sandbox." The product term "Managed Agents" remains in the card's help line. This is minor.
4. The "My computer" choices were seen only in the Move to list. This workspace has no machine, so the "My computer" Runs on card and its Edit form (model id plus Turn limit) were not exercised.

## Verdict

**pass.** All four flows worked at both sizes, for a Cloud agent and an Anthropic cloud agent, with no console errors and no failed requests. The Runs on card, the Edit form and the Move agent dialog use only Cloud, Anthropic cloud and My computer. Advanced is closed by default and holds Environment, Network access, Turn limit and the model id. Finding 1 (the "Cloudflare" label on Start blank) should get a follow-up.
