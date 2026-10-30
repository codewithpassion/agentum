# Northbank Advisory: Chief of Staff walkthrough

The concept and scene list for the recorded run on staging. The format follows the
Harbour Edge video pipeline (`## sNN · Title`, `Screen:`, `> [sNN-n]`), so a voice-over
later is a TTS step, not a rewrite. This version is silent, with the narration lines
burned in as captions.

## The concept

Northbank Advisory is a made-up nine-person consulting firm. Priya Nair runs operations.
Nobody there writes code. Mail comes in to one office address, and the partners lose
hours each week sorting it.

Priya wants a chief of staff that:

- reads incoming mail and sorts it into client work, invoices and admin, or noise,
- drafts client replies and says who should own them, but sends nothing without a person,
- passes overdue invoices to a second agent, Invoice Chaser,
- posts a short 8am briefing of what needs a human today.

Agents support the humans here. The test of the UI is whether Priya can set this up
alone and then live in it, with the plumbing out of her way.

Test values:

| Thing | Value |
|---|---|
| Staging | https://harbourmaster-staging.rockyshoreslabs.io |
| Persona | Priya Nair, `priya@office.northbank.rockyshoreslabs.io`, org Northbank Advisory |
| Team page | `tooling/team.md` |
| Models | Haiku 5.5 on both agents |
| Simulated mail | `tooling/emails.md` |

## How mail is simulated

Gmail is not available to this run, so the mail is simulated. A second throwaway workspace,
Outside Senders, holds one agent, Client Mail Sim. Its mail goes out through Cloudflare and
comes back in through the same Email Routing path a real client's mail takes.

Two things had to change from the first plan, and both are findings:

- Mail from an agent in the same workspace is stored but starts no run. That is a loop
  guard in `packages/services/src/mail/inbound.ts`, and it is correct. It also means
  nobody can test the mail path from inside their own workspace.
- Port 25 is blocked from this host, so spoofing a client's address over SMTP was out.
  Each email starts with an "Originally from" line instead, and the agent's rules say to
  trust it. A real client address would not need that rule.

The simulator's work happens off camera and the caption says so. Replies Priya approves go
to the reserved `.example` domain named in the "Originally from" line, or to the simulator's mailbox, so no outside person gets mail.

## Scenes

## s01 · Cold start

Screen: fresh sign-in lands on the Desk. Rest on the three empty lanes. Move across the
sidebar, open More.

> [s01-1] Priya signs in for the first time. The Desk is empty, and nothing says what to do first.
> [s01-2] The sidebar already lists thirteen places, plus Settings.

## s02 · The first wall

Screen: + New task shows "Create an agent first". + New agent. Paste the description, pick
Careful, press Draft. The error appears.

> [s02-1] New task can't start without an agent, so she goes to New agent.
> [s02-2] She describes the job in plain words and presses Draft.
> [s02-3] The workspace has no Anthropic key. The error names the setting but has no link, and she has no idea what a key is.

## s03 · Keys

Screen: Settings, Model providers. Paste the Anthropic key, save. Move over the Settings
sub-nav. Paste the OpenRouter key, save.

> [s03-1] Settings has seven pages under three headings. Model providers is first.
> [s03-2] A non-technical owner now needs an Anthropic console account and a billing setup before seeing any value.

## s04 · The builder

Screen: back to New agent. The description is gone, so paste it again. Draft. Scroll through
the draft and what the builder did.

> [s04-1] The description didn't survive the trip to Settings, so she pastes it again.
> [s04-2] This is the best moment in the product. Eight seconds later there is a named agent with rules, a schedule and a mail address.
> [s04-3] The left panel leaks the plumbing, though. A cron string, and a build task number: V5.

## s05 · Dry run

Screen: Run the dry run on the sample. Result arrives. Scroll the receipt.

> [s05-1] The dry run tries the agent on a sample email, with nothing saved or sent.
> [s05-2] The builder left the sample empty, so it made up five emails and said so. The receipt around it reads like a developer's log.

## s06 · Create and profile

Screen: pick Cloudflare, Create agent. Profile page. Move across the rows. Open Edit, show the
model list and the runtime text. Pick Haiku, save.

> [s06-1] Runs on offers Anthropic cloud or Cloudflare. Nothing helps her choose, and the model isn't here at all.
> [s06-2] The profile puts everything on one page, which is good. It also shows the 8am briefing on the wrong clock, London or UTC depending on the draft, and Priya is in Sydney.
> [s06-3] The model sits behind Edit, next to a paragraph about isolates, VMs and short-lived sandboxes.

## s07 · A second agent

Screen: New agent, Chase late invoices template, edit the description, Draft, Cloudflare, Create.
Back to Chief of Staff, Hands to, Manage, turn on Invoice Chaser.

> [s07-1] The template fills the description in one click.
> [s07-2] Hand-offs live under a Manage button on the profile, and also on the Map.

## s08 · Teach it the team

Screen: Library, New page in the Wiki, title Team, paste the roster, save.

> [s08-1] The agent asked for a roster, so Priya adds one to the wiki. Agents can read the wiki by default.

## s09 · Connections

Screen: Settings, Connectors, Add connector. Show the empty form, then add a no-auth server
by URL. Chief of Staff, + Add tool. Then Channels, Manage, the Slack steps.

> [s09-1] Connections start from a blank form asking for a server URL. There's no list of apps, and no Gmail or Google Calendar button.
> [s09-2] A secret is a separate page with its own proxy and env rules.
> [s09-3] Slack means leaving for api.slack.com, pasting a manifest and copying two tokens back. It works. Priya would stop here.

## s10 · Mail arrives

Screen: off camera, the simulator sends five emails and they are approved. Desk updates. Read the
mail strip, the lanes, the card titles.

> [s10-1] Five emails arrive from the simulator, and the wait is cut. Chief of Staff wakes up on each one.
> [s10-2] The work is real and the Desk is honest. But every mail task is titled Inbound mail, the quoted JSON below is untrusted content.
> [s10-3] Priya can't tell the board-pack emergency from the newsletter without opening each one.

## s11 · Needs you

Screen: read the approval card. Deny one, with a note. Allow one. Open a Done card to the Task
page. Scroll the receipt and the right rail.

> [s11-1] This is what the product is for. A person decides, and the agent waits.
> [s11-2] But the heading says Use mail_send, the reply is in a code font, and it expires in one hour. A mail held at 7pm is gone by the 8am briefing.
> [s11-3] The task page shows everything. Tool calls, a run id, a cost, an action log and a thread that repeat each other.

## s12 · Map

Screen: Map in Runs view, then Editor. Fit view.

> [s12-1] The map is the clearest picture of the system. It names mail addresses and folders where Priya would think of clients, invoices and briefings.

## s13 · The rest

Screen: quick pass through Q&A, Artifacts, Skills, Machines, then More: Inbox, Sessions, Log, Routines, Triggers.

> [s13-1] Q&A, Inbox and the Desk are three places a person can be asked something.
> [s13-2] Sessions, Log and the Task page are three views of the same runs.
> [s13-3] Every one of these works. The problem is that they all sit at the same level, on the first day.
