# JB.3 review: Describe a job, get a draft

## Verdict per round

- Round 1, 00c578d8: must-fix. The tool input schema had a union at its root, which the Anthropic Messages API refuses, so every real draft would have failed. The reply also allowed an `app` source that the spec does not list.
- Fix round 1, 11fb58a2: clean. The reply is one flat object with a `needs_when` source, and `app` drafts are gone. "When I ask" and text with no time or event come back as a message that asks for a time or event.

## Nits left

- `job-drafting/draft.ts`: stale comment about union branches and a redundant `type: "object"` override.
- An empty `asksBefore` or `deliversTo` from the model passes through as an empty string instead of null.
- The `?? ""` and `?? null` fallbacks after the completeness checks cannot be reached.
- A Slack event gets the "say when it should run" message, which misleads a person who did name an event.
- Tests: the schema check looks for `anyOf` only, no test covers a parsed reply with an empty `does` or `when`, and the "when I ask" test scripts the model instead of testing the prompt.
- The drafter repeats the authz and length checks that `jobs.ts` already runs, with a literal 2000 instead of `JOB_TEXT_MAX`.
- The agent's whole `instructions` go into the prompt with no cut-off, where agent-builder cuts to 200 characters.
- Agent and workspace reads run one after the other.
- A non-ok model response is retried without a log line, as in agent-builder.
- `jobs.ts` doc comment still says "Stub". JB.2 rewrites that file.

## Beyond the scope

- A routine's `when` is the model's wording. After JB.2 lands, `cronToWords` could write it from the validated cron and timezone so the draft reads like the saved job.
- A Slack draft source, once a Slack app can be named in the text.
- The model may name another IANA zone when the person does. The spec says the workspace zone, so this is a small extension for Dom to keep or drop.

## Steps for Dom

None. The draft needs the workspace's Anthropic key, as the agent builder does. The first real call has not been made against the live API, so try "Every Friday, summarise support tickets for me" once the Jobs tab (JB.4) can show a draft.
