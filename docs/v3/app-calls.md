# App calls and the apps list

Status: requested by Dom on 5 Nov 2026. Tasks AL.1 to AL.4.

## Why

A person who builds a bot can't see whether its endpoint was called or what went wrong. Apps are also hard to find: they sit in "Things agents made" behind a kind filter.

## AL.1: access log fix

`listViews` returned `guestId`, which the strict `artifactViewSchema` doesn't allow, so `artifacts.views` answered 500 for any artifact with a logged open. The query leaves `guestId` out, like the visitor hash.

## AL.2: Calls tab

Endpoint calls are already saved as `artifact_views` rows with `surface = "live_call"` and `tool_key = "endpoint:<name>"` (`recordCall` in `packages/services/src/artifacts/endpoints.ts`). They have no status code or timing.

- Schema: `artifact_views` gets two nullable integer columns, `status_code` and `duration_ms`. Other surfaces leave them null.
- `mountEndpointRoutes` measures the time around `handleEndpointRequest` and passes the response status and the duration to `recordCall`. The outcome rule stays: `error` for 500 and up, otherwise `ok`.
- Service: `calls(principal, { artifactId, cursor? })` pages the endpoint rows of one artifact, newest first, 50 a page, with the same access rule as the access log (owner or admin, browser session). Each row: id, time, endpoint name, status code, duration, outcome, place, version number. The visitor hash and IP stay out.
- `artifacts.appErrors({ artifactId })` exposes the existing `errors.list` (the last 10 `app.error` events) to the same people.
- tRPC: `artifacts.calls` and `artifacts.appErrors`, both `workspaceProcedure` with strict output schemas in `@repo/protocol/artifacts`.
- UI: a "Calls" tab after "Access log" on the artifact page, for an `app` artifact and someone who can manage it. It shows "Recent errors" (time, version, entry, message, and how many similar errors were dropped) when there are any, then the call table (time, endpoint, status, duration, place, version) with Load more and a Refresh button. Empty state: "No calls yet. Requests to this app's endpoints show here." Phones get stacked cards, like the access log.

## AL.3: apps on the rail

- The rail footer gets "Apps" between "Agents" and "Files", linking to `/artifacts?kind=app`.
- Find gets "Apps" in "What agents use", hint "Artifacts", to the same address.

## AL.4: Source tab

An artifact keeps its own copy of its files, so they aren't in the library. Today the only way to read them is the zip from Download.

- A "Source" tab on the artifact page, for anyone who can open the artifact (the same rule as Download). The tab bar shows for them even when they can't manage the artifact. Access log and Calls stay for managers.
- It shows the files of the version on screen (the version picker's choice): path, size, and type, entry file first, then `server/` files, then the rest by path.
- Picking a text file shows its text read-only, in a monospace block with line numbers and no syntax colouring. A binary file shows its type and size and a note that Download has it. The entry file opens first.
- tRPC: `artifacts.files({ artifactId, version? })` lists the files, and `artifacts.readFile({ artifactId, path, version? })` returns the text through the existing `readFile` service method. Both `workspaceProcedure` with strict output schemas. Add a service method for the list if none exists, with the same access check as `readFile`.
- A file over 512 KB of text shows the first 512 KB and says it was cut.

## AL.6: Endpoints tab

Dom, 5 Nov 2026: there is no visible way to see an app's endpoints and copy their URLs. The list exists (`EndpointSettings`, with copy, disable, enable and rotate) but sits inside the Share dialog, where nobody looks.

- The Calls tab is renamed "Endpoints" (tab value can stay `calls`). Same audience: an `app` artifact and someone who can manage it.
- The tab shows, top to bottom: the endpoint list (`EndpointSettings`, unchanged behaviour: name, full URL, Copy, Disable or Enable, Rotate), then Recent errors, then the call table.
- Each URL is shown in full in a monospace, selectable block that wraps, so it can be copied by hand too. Copy confirms with "Copied" as it does today.
- Empty state when there are no approved endpoints: "This app has no approved endpoints yet. An endpoint is declared in the app's agentum.json and goes live when its version is approved."
- The endpoint list leaves the Share dialog, so it has one home.
