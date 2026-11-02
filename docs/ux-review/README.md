# Harbourmaster UX review, October 2026

The rail, which came out of this review, is built. See `rail/spec.md`, `rail/results.md` and `media/rail/harbourmaster-rail.mp4`.

A walkthrough of Harbourmaster on staging as a non-technical user, plus three redesign directions.

| File | What it is |
|---|---|
| `review.md` | Current structure, timings, 24 findings, three directions and my pick |
| `script.md` | The concept and scene list, with narration lines ready for a voice-over |
| `mockups/index.html` | The three directions, interactive. Open it in a browser. It only needs the network for fonts. |
| `media/out/harbourmaster-walkthrough.mp4` | The silent 3:24 video with burned-in captions |
| `media/screens/` | Numbered screenshots from the video's run, and `dry-*` from the dry run |
| `media/mockups/` | Screenshots of each mock-up state |
| `tooling/` | The recorder and helpers. Run `bun install` there first. |

`media/` is git-ignored, so the video and screenshots stay on this machine unless they're copied elsewhere.

## See it on staging

The final workspace is Northbank Advisory, with Chief of Staff and Invoice Chaser. To sign in as Priya, run this from `apps/web`, then open the one-time URL in a fresh browser session:

```sh
bun run agent-login --env staging --email priya@office.northbank.rockyshoreslabs.io --redirect /desk
```

## What this changed on staging

Nothing was deployed and no code changed.

- The `ALLOWED_ORG_IDS` secret now has ten ids. Six are new, for the workspaces below. Two are production-instance orgs copied from the `workspaces` table so that no existing org lost access, and they do nothing on the dev instance staging runs on. `apps/web/.env.staging` (git-ignored) holds the same list. Cloudflare can't show a secret's value, so I never saw the live list before overwriting it. It could have held an id that wasn't in `.env.staging` or the table. If an org loses access on staging, add its id back.
- Eight Clerk users and six organisations exist on the dev instance for this work. Dan and Sam are members of the final Northbank Advisory:

| Workspace | User | State |
|---|---|---|
| Northbank Advisory, final | `priya@office.northbank.rockyshoreslabs.io` | Live. Its routine fires on weekdays at 08:00 UTC at a small cost. Its Done list also has a task from my failed attempt to publish the mock-ups, and API keys has one revoked key from the same attempt. |
| Outside Senders | `ux-sim@rockyshoreslabs.io` | Holds Client Mail Sim, which only runs when asked |
| Firstday Studio | `nina@firstday.rockyshoreslabs.io` | First-day test. Agent archived, key removed |
| Northbank Advisory, dry run | `ux-review@rockyshoreslabs.io` | Agents archived, keys removed |
| Northbank Advisory, take 1 | `priya@northbank.rockyshoreslabs.io` | Agents archived, keys removed |
| Northbank Advisory, take 2 | `priya.nair@northbank.rockyshoreslabs.io` | Agents archived, keys removed |

- The final and simulator workspaces hold the Anthropic key from `apps/web/.env.local`, encrypted. Remove it on each workspace's Model providers page when you're done.
- Mailbox addresses and Email Routing rules exist on `rockyshoreslabs.io` for each agent created.

## Mail that was sent

25 simulated emails went between agents on `rockyshoreslabs.io` during the review, and about 15 more during the rail test. Approved replies went to reserved `.example` addresses and bounced, as expected. No outside person received anything.

## One thing I did not chase

My attempt to upload the mock-up into `agents/northbank-chief-of-staff` landed in `agents/`, with no error, while the breadcrumb showed the deeper folder. It came from a scripted browser and I only saw it once, so it may be timing. It is worth a look at the upload path in the Library. I deleted the stray file.

## Re-recording

`tooling/record.ts` needs an empty workspace from `tooling/provision-final.ts`, whose org gets a workspace row from `add-workspace`, and unused agent addresses. Model output changes per run, so check the captions against the frames. The final video joins two sessions, because the first stopped on a selector after the approval scene, and one caption in the dry-run scene was replaced with an ffmpeg overlay. `RESUME=1` continues a run from that point.
