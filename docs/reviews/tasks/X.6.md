# X.6 review

## Rounds

Round 1, at 7d236a9: must-fix, two items. A relay whose per-block check failed left the live Durable Object subscription open, because a failed `pull` does not run `cancel`. And the resume test stopped at the replay's copy of the late request, so it did not prove the live duplicate is dropped. Both are fixed in 69ef18e: `relay` cancels the live reader when a pull fails (with its own test), and the resume test reads on to a sentinel request opened after the late one.

Round 2, at 69ef18e (fix commit only): clean.

## What was built

`GET /api/desk/stream` in `routes/desk.ts`, with X.2's `memberOrRefusal` (an `hm_key_` key with the `desk` scope plus `X-On-Behalf-Of`). The key is stamped once per connection, after the subscription and replay succeed.

- Fan-out reuses the `SessionStream` class under a second instance name, `desk:<workspaceId>` (`deskStreamName`). No new class, no wrangler migration. `streamListener` publishes the frames of every `request.*` and `run.*` event to that instance as well as to the session's own.
- Filter per member: a frame's `runId` goes to the new `deskApi.canSeeRun(member, runId)`, which is the `visibleSessions` rule `listPending` uses. The route caches the answer per run for the connection. A frame with no run, or one in a session the member may not see, is dropped, replay and live alike. Pings pass.
- Resume: `Last-Event-ID` (or `?after=`) replays `events.query(member, ..., { after, types: DESK_EVENT_TYPES })` in pages of 500, then the live frames, dropping live copies of replayed ids. The subscription comes before the replay read, as in `routes/session-stream.ts`. `replay` and `relay` there are now exported and take a scope and an optional per-item keep function. `/api/sessions/:id/stream` behaves as before.
- No resume point means no replay, as on the session stream.

## For the coordinator to confirm

- C4 names no frame set. The one chosen: `event` frames for `request.opened`, `request.answered`, `request.expired`, `request.cancelled` and the `run.*` types (`run.queued`, `run.started`, `run.waiting`, `run.resumed`, `run.finished`, `run.failed`, `run.cancelled`, `run.interrupted`, `run.limit_reached`, `run.repeat_stopped`), `run` frames (`{ frame: "run", runId, status }`) and `ping` frames. Shapes are those of `@repo/protocol/stream`. Only `event` frames carry an SSE `id:`, so only they resume.
- The task's Refinements say `events.query` applies `visibleSessions` itself. It does not (`events.list` does). The route filters replayed events with `canSeeRun` instead.
- The stream carries no message text or tool calls. flightdex reads the request detail from `GET /needs-you` when a `request.opened` frame arrives.

## Nits left

- A bogus or very old `Last-Event-ID` replays every `request.*` and `run.*` event of the workspace after it, built as one string before the response starts. A long replay can also make the Durable Object drop the writer (100 unfinished writes), after which the client reconnects with its last id. A cap or a time bound would fix both.
- Live `run` frames have no `id:`, so a client may see a status frame for an event it already has from the replay. Harmless, and the session stream does the same.
- The per-connection `canSeeRun` cache keeps its answer for the life of the connection, so a session that turns private mid-connection keeps streaming.
- No test for a private DM (non-ui origin, `private: true`) on the stream. The rule is `visibleSessions`, which has its own tests.

## Beyond the scope

- A workspace-wide event stream with a `sessionId` on the frame, which would save the per-run lookup.
- A replay time bound for the desk stream.

## Steps for Dom

- After merge and staging deploy, with a desk key and `X-On-Behalf-Of`: `curl -N` the stream, then trigger an approval. The `request.opened` frame should arrive within a second (the check the task leaves to the controller).
