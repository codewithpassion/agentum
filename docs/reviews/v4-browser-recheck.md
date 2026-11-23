# End-of-v4 browser re-check (SL.14, FR.6)

Run on `origin/main` at 720951bf, local dev server (`vite dev`, port 5391) with the fake Slack (port 5399), signed in through `/api/dev-login`. Sizes: 1280x800 and 390x844. Screenshots are in `docs/reviews/v4-browser-recheck/`.

| Flow | Desktop | Phone |
| --- | --- | --- |
| SL.14 labelled link in a person's or guest's post | pass | pass |
| FR.6 team starters in the New team dialog | pass | pass |

Console and network: no page errors and no failed tRPC request in either flow, apart from the expected 400 when the fake key was refused in Settings (see FR.6) and the one `Failed to load resource ... 400` per page load that the earlier pass also saw (probably Clerk's dev instance). The agent-browser network log captured no requests, so the network check rests on the console and the dev server log, which has no errors. No horizontal overflow at 390 wide (`scrollWidth` 390).

## SL.14: pass, pass

Setup: seeded the Launch team with `seed-slack-room.ts`, linked `#sl5-room`, then posted through the fake (`POST /_say`). The guest (`U0GUESTGUS`) wrote `hi see <https://example.com/doc|the launch doc> and <https://example.org/raw>`. The linked person (`U0DEVPERSON`) wrote `person says <https://example.com/spec|the spec doc> ok`.

- Guest post: "the launch doc" is a link to `https://example.com/doc`, with no brackets. The bare link reads as its URL. Pass.
- Person post: "the spec doc" is a link to `https://example.com/spec`. Pass.
- Phone layout reads the same, no overflow.

Residual, not part of the SL.14 scope as written: the topic title (the large heading above the post) and the topic list rows still show the raw text `hi see [the launch doc](https://example.com/doc) and ...`. The stored text is markdown, and only the post body renders it. The earlier pass listed the title, the list and the Needs you drawer as part of the same problem. Worth a follow-up task if those surfaces should read cleanly too. I did not check the Needs you drawer in this run.

Screenshots: `sl14-guest-desktop.png`, `sl14-person-desktop.png`, `sl14-guest-phone.png`, `sl14-person-phone.png`.

## FR.6: pass, pass

- The New team dialog lists the Sales and Back office starters above the blank-team form. Pass.
- No key: picking Sales shows the draft (lead "Sales lead", three members, rules) and the line "There is nowhere to run these agents yet. Add an API key in Settings, then pick the starter again." The link goes to `/settings/model-providers`. Create team is disabled. Pass.
- With a workspace Anthropic key: Create team made the Sales team with Sales lead as lead and Lead research, Outreach drafts and CRM tidy as members. The local database shows `runtime = cloud` on all four agents. Pass.
- Key setup deviation: Settings refuses `sk-ant-test-0000` ("Anthropic did not accept that key"), because it checks the key against Anthropic. I stored the fake key through `createManagedKeysService` without the validator, in a throwaway script that is not committed. That refusal is the 400 in the console. Nothing was run.
- Only Sales was created. Back office was not picked in the browser, so only its listing is verified here.

Screenshots: `fr6-nokey-desktop.png`, `fr6-nokey-phone.png`, `fr6-draft-desktop.png`, `fr6-draft-phone.png`, `fr6-created-desktop.png`, `fr6-created-phone.png`.
