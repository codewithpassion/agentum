# Artifacts and micro apps: product requirements

Written 27 Oct 2026 from Dom's voice brief of the same day. Status: draft for Dom's review. Nothing here is built yet.

## Summary

Agents in Agentum will publish artifacts: HTML pages, markdown documents and data dashboards. An artifact shows as a card with a live preview in the task thread. It opens at its own link inside a thin Agentum frame with its title, owner, version and share controls. At first only workspace members can open it. Then its owner can make a revocable "anyone with the link" share, and every open, anonymous ones included, lands in an access log. Later phases turn artifacts into versioned micro apps with server-side code and per-app storage, add Git sync, and add richer sharing.

Artifacts live on the app's own origin, as Dom decided on 27 Oct 2026: `/a/<uuid>` is the framed view and the content sits under it. The one rule this design won't bend is that artifact code never runs with the app's origin. Every content response carries `Content-Security-Policy: sandbox allow-scripts allow-forms` without `allow-same-origin`, so the page runs in an opaque origin even when someone opens its URL directly, and the viewer embeds it in an iframe with the same sandbox. The main Worker serves the content. There is no second Worker and no second domain.

## Problem

Agentum is the front end of Dom's AI OS (`~/devel/ai-os-integration/README.md`). Its agents already write files, but a file an agent writes cannot become a page people look at:

- `GET /files/:id` serves HTML, SVG and XML as downloads under `Content-Security-Policy: sandbox; default-src 'none'` (`apps/web/src/server/routes/files.ts:36-60`, `fileResponseHeaders` at line 99).
- `/api/library/download` always answers `application/octet-stream` with `attachment` (`apps/web/src/server/routes/library.ts:34-63`).
- The library page shows an `.html` file as source in a textarea (`apps/web/src/components/library/library-file-panel.tsx:410`).
- There is no `<iframe>`, `srcdoc` or `postMessage` anywhere in `apps/web/src` (sweep of 27 Oct 2026).

Those rules are right for the app's origin and must stay. The gap is a safe place to render agent-made pages, a way to show them where the work happens, and a way to share them with people who don't have an Agentum login.

Claude's desktop app has "dashboards" and claude.ai has artifacts, which are close to what Dom wants, but they live in Claude, not in the AI OS, and they can't use Agentum's agents, library, connectors or audit trail.

## Goals

1. An agent on any runtime can create and update an artifact with platform tools, and can test it before it tells a person it is done.
2. People see the artifact where they already work. It shows as a card in the task thread, in the task view, and in an Artifacts area.
3. Every artifact has its own link that opens inside an Agentum frame with its title, owner, version and share controls.
4. Untrusted HTML and JavaScript are served from the app's host but always run in an opaque origin, with no access to the user's Clerk session.
5. Sharing outside the workspace is deliberate, managed (listed, revocable, expiring) and logged, including anonymous opens.
6. Artifacts can grow into micro apps with server parts and storage that run inside the AI OS (phase 2).

## Non-goals

- A general website host or a public app store.
- Custom domains for artifacts (phase 4 at the earliest).
- Real-time co-editing of an artifact's source by people. Agents write artifacts; people restore, rename and share them.
- Git sync in phase 1 or 2. It is phase 3.
- Comments on artifacts. They are phase 4.
- Running artifact code in the Linux VM or on a machine. Artifacts run in the browser, and phase 2 server parts run on Cloudflare.

## Users

| User | What they need |
|---|---|
| Dom | Ask an agent for a report or dashboard, look at it on desktop or phone, send a link to a client or colleague, see who opened it, revoke it. |
| Workspace members | Open artifacts made in shared sessions, find them later in one place, share their own. |
| Agents | Publish, update, read and test artifacts with tools, on the cloud isolate, the Linux VM, Managed Agents and machines. |
| External viewers | Open a link without an account and see the content inside a frame that says who shared it and that it is unverified. |
| Workspace admins | Turn link sharing off for the workspace, revoke any link, read any access log. |

## Use cases

1. Dom asks the research agent in the web chat for a one-page market summary. The agent writes `index.html`, publishes it, runs `artifact_test`, and replies. The card in the thread shows a live preview. Dom opens it full screen at its link.
2. A routine runs the finance agent every morning. The agent writes `data.json` from Xero through its connector, updates the "Cash dashboard" artifact with a new version, and the dashboard's chart reads the new file. Members open the same link each day and see the latest version.
3. Dom shares the market summary with a client. He creates an "anyone with the link" share that expires in 7 days and pastes the link into an email. The client opens it without signing in. Dom sees the open in the access log with country, city, network and browser. After the meeting Dom revokes the link, and the next open fails.
4. A member opens an artifact on a phone from a Slack notification. The frame collapses to a title bar and a menu, and the content fills the screen.
5. An agent updates an artifact and breaks it. Dom opens version history, picks version 3 and restores it. Version 5 is created with version 3's files.
6. (Phase 2) An agent builds a "Client intake" micro app with a form, a server part that validates and stores submissions in the app's own storage, and a list view. Members open it from the sidebar. The agent writes tests, runs them, and promotes the version once they pass.
7. (Phase 2) A dashboard calls the Linear connector live with the viewer's own credential, so each member sees their own issues. Link viewers see the last snapshot only.
8. (Phase 3) The intake app's versions push to a GitHub repo as commits, and a change made in GitHub comes back as a proposed version.

## How Claude's artifacts work (reference model)

Facts below come from public docs as of 27 Oct 2026, unless marked otherwise.

- Hosting. claude.ai loads each artifact from a sandboxed `*.claudeusercontent.com` origin. Scripts load only from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and some jsDelivr paths, fonts only from Google Fonts, external images are blocked, and `fetch` reaches only the page's own origin and Google Fonts. Pages are capped at 16 MiB. ([code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts)) The exact iframe `sandbox` tokens are unverified. Anthropic engineers described "iFrame sandboxes with full-site process isolation" in a secondary source ([Simon Willison, Aug 2024](https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts)).
- Sharing. Artifacts start private. Owners share with the organisation, with invited people by email (beta, up to 50 outside invitees, invitations expire after 30 days) or with anyone with the link, at view, comment or edit level. Org owners must turn on external sharing first, and turning it off blocks existing public links without changing each artifact. Publish, share and delete events go to the org audit log. Public viewers from outside the org see "Content is user-generated and unverified." in place of the author's name. ([support.claude.com share-artifacts](https://support.claude.com/en/articles/9547008-share-artifacts), [code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts))
- Versions. Each publish is a version. The share control picks which version viewers see, with an "always share latest version" toggle. A publish built on a stale copy is refused. (same source)
- Capabilities. A page can keep personal (per viewer) or shared storage, up to 20 MB of text per artifact. It can call Claude, with usage counted against each viewer's own plan. ([support.claude.com 9487310](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)) The API names `window.claude.complete` and `window.storage` come from secondary sources and are unverified.
- Connectors. A page declares the connectors it may call. Each call runs with the viewer's own connection after the viewer approves it, the page never sees credentials, and calls never run for anonymous or outside viewers. Tools that need per-action approval aren't available to artifacts. ([code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts))
- Comments exist on org-shared artifacts only.
- Abuse. In July 2026 a public claude.ai artifact posed as the Claude Desktop download page, was promoted with Bing ads, reached about 7,100 views and delivered SectopRAT before removal ([Huntress](https://huntress.com/blog/fakeagent-claude-desktop-malvertising-ends-in-dotnet-rat), [BleepingComputer](https://bleepingcomputer.com/news/security/fake-claude-app-promoted-by-bing-ads-pushes-sectoprat-malware)). Artifacts and shared chats were also used in ClickFix campaigns ([Zscaler](https://www.zscaler.com/blogs/security-research/claudefix-shared-claude-chats-meet-clickfix)). No published case of data exfiltration through an artifact was found.

The MCP Apps extension (SEP-1865, stable since 26 Jan 2026) standardises the same idea for MCP hosts: HTML resources at `ui://`, rendered in a sandboxed iframe on an origin different from the host's, talking to the host through JSON-RPC 2.0 over `postMessage` (`ui/initialize`, `ui/open-link`, `ui/message`, `tools/call`). The host proxies tool calls and rejects tools not marked for apps. Pages declare `connectDomains` and `resourceDomains`, and hosts may tighten but never loosen the CSP. ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)) OpenAI's Apps SDK now speaks the same bridge ([developers.openai.com](https://developers.openai.com/apps-sdk/build/chatgpt-ui)).

What Agentum copies: UUID paths on the main domain for the viewer, private or org-scoped by default, sandboxed content, a CDN allowlist CSP, versions with stale-publish refusal, an org switch for external sharing, viewer-rights connector calls that never run for anonymous viewers, the "user-generated and unverified" label, and the MCP Apps message names for the bridge. What it adds: agents as authors with a test tool, an access log of anonymous opens, share-link expiry and per-link revocation, and (phase 2) server parts.

## What exists in Agentum today

| Area | What is there | Where |
|---|---|---|
| Library | Workspace file tree in R2 with per-file versions, 30-day prune, agent folder grants, task output folders | `packages/services/src/library.ts`, `packages/db/src/schema/library.ts`, `packages/services/src/library/versions.ts:255`, `taskFolderPath` in `packages/db/src/shared.ts:166` |
| Wiki | Markdown under `wiki/` in the library, rendered with `react-markdown` and `skipHtml` | `packages/services/src/wiki/`, `apps/web/src/components/markdown/markdown.tsx` |
| Skills store | Full-tree versions, content-addressed blobs at `skill-blobs/<sha>`, `number` unique per skill to refuse racing commits, agents propose and people approve, GitHub import pinned to a commit | `packages/db/src/schema/skills.ts`, `packages/services/src/skills-store.ts`, `apps/web/src/server/github-skill-source.ts` |
| Sessions | `ui` sessions and private sessions (Slack DMs) are visible only to their opener | `visibleSessions` in `packages/services/src/sessions.ts:180`, `sessions.private` in `packages/db/src/schema/sessions.ts:26` |
| Thread | assistant-ui, one fallback renderer for all tool calls, data parts for requests and attachments | `apps/web/src/components/thread/assistant-message-container.tsx:91-101`, `thread-parts.ts:60-72`, fold in `packages/protocol/src/thread.ts:441` |
| Live stream | `SessionStream` DO, SSE with replay, gated by `STREAM_EVENT_TYPES` | `apps/web/src/server/session-stream.ts`, `apps/web/src/server/session-stream-frames.ts:13` |
| Task view | Receipt, action log and slots (Files, Computer, Mail, Thread) | `apps/web/src/components/task/task-page.tsx:289-325`, `slots.tsx` |
| Platform tools | One MCP server named `agentum`, zod schemas, annotation presets, dry-run gate on non-read-only tools | `packages/mcp/src/tools/define.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/register.ts` |
| Tool approval | Rule keys `harbourmaster/<tool>` work in all three runtimes | `packages/protocol/src/requests.ts`, `apps/web/src/server/pi-run-gate.ts`, `apps/daemon/src/approvals.ts`, `packages/services/src/managed/gateway.ts` |
| Browser | Browser Run through `@cloudflare/playwright`, SSRF guard, screenshots to the task folder | `apps/web/src/server/browser-run.ts`, `packages/services/src/browser/` |
| Untrusted code | Dynamic Worker per run through the `LOADER` binding, with a `ScriptHost` capability binding made by `ctx.exports` with props | `apps/web/src/server/skill-scripts/dynamic-worker-sandbox.ts`, `apps/web/src/server/script-host.ts`, `apps/web/wrangler.jsonc` (`worker_loaders`) |
| Auth | Clerk orgs as workspaces, `workspaceProcedure`, bearer resolver for `hm_*` tokens, `isAdmin` from `org:admin` on session principals only | `apps/web/src/server/trpc/init.ts:74`, `packages/services/src/workspaces.ts:22-50`, `workspaces.ts:258-397` |
| Authz | `can()` checks workspace isolation only and ignores the action | `packages/services/src/authz.ts:17-26` |
| Audit | Append-only `events` with BEFORE UPDATE and DELETE triggers, no retention | `packages/db/src/schema/events.ts`, `packages/db/migrations/0000_init.sql:357-367` |
| Tokens | HMAC run tokens, hashed API keys, AES-GCM secret encryption | `packages/services/src/run-tokens.ts`, `packages/services/src/crypto.ts:123-191` |

Four findings shape the design:

1. `can()` passes any principal whose `workspaceId` matches (`authz.ts:17-26`). A new principal kind for anonymous link viewers would pass every service's `authorize()` call. Link viewers therefore must not be a `Principal`.
2. Pi agents never see images from MCP tools. `contentText` turns every non-text part into the text `[image]` (`apps/web/src/server/pi-run-mcp.ts:429`). A test tool must return its findings as text.
3. The Linux VM image has no Chromium (`apps/web/container/Dockerfile`), and only `/workspace/home` survives sleep. Browser testing goes through Browser Run.
4. Most chat-made work is private: web chat sessions have origin `ui` and are visible only to the person who opened them (`sessions.ts:186-193`). An artifact made there must not default to workspace-wide.

## Design

### 1. What an artifact is

An artifact is a workspace-owned, versioned bundle of files with one entry file, a title, a kind and an audience.

Kinds:

| Kind | Entry | Phase | What it is |
|---|---|---|---|
| `page` | `index.html` | 1 | Static HTML, CSS, JS and images. |
| `doc` | `index.md` | 1 | Markdown rendered by a platform viewer inside the sandbox. |
| `dashboard` | `index.html` | 1 | A page that reads data files shipped in the same version (for example `data.json`). Fresh data means a new version. |
| `app` | `index.html` plus `server/` | 2 | A micro app with a server part, storage and declared tool grants. |

Kind is a label for the UI and for limits. Phase 1 serves `page` and `dashboard` the same way.

Versions are immutable full trees, like skill versions (`packages/db/src/schema/skills.ts`). Each version has a `number` that counts up per artifact and a `parent_number`. A unique index on `(artifact_id, number)` refuses two updates raced on the same base, the way `commit_skill` refuses a stale `baseVersion` (`skills-store.ts`, `commit` at line 1148). Restoring version 3 creates a new version with version 3's tree, so history only grows. File bytes are content-addressed in R2 under `<workspaceId>/artifact-blobs/<sha256>`, and each version also writes a manifest object `<workspaceId>/artifact-manifests/<versionId>.json` (path to hash, size and content type). The content route reads only the manifest and the blobs, never D1.

Ownership has three parts:

- The workspace owns every artifact (`workspace_id`, as every table has).
- The author is recorded per version: a person, or an agent with the run that wrote it.
- The owner is the accountable person: the creator when a person publishes, or the run's `on_behalf_of_user_id` when an agent does (`packages/db/src/schema/runs.ts:41`). A trigger or routine run with no person has no owner, and workspace admins act as owner.

Audience in phase 1 is `private` (owner only) or `workspace` (every member). Link shares sit on top of either. The default comes from the session the artifact was made in (Dom's decision, 27 Oct 2026): a `ui` or private session gives `private`, any other session gives `workspace`, and a person publishing outside a session gets `private`. This follows `visibleSessions` so an artifact never shows more than its conversation did. Phase 4 adds `people` and `public`.

Relation to the library. Artifacts are publications, the library is the working tree. An agent builds in its task folder (`agents/<slug>/tasks/<runId>/`), where its file and bash tools work, then publishes the folder as a version (`fromLibraryPath`). The version records `source_library_path`. Artifacts are not library files, for three reasons: library versions are per file with no tree snapshot, the library prunes versions after 30 days (`LIBRARY_VERSION_KEEP_DAYS`), and the library syncs onto machines and VMs, which published pages don't need. The skills store made the same split when it moved skills out of the library (`skill_library_migrations`).

Relation to sessions and the thread. Every version stores `run_id` and the run's session. Publishing appends an `artifact.published` event with `sessionId` and `runId`, so it reaches the session stream and the thread fold. The artifact page links back to "Made in task …" when the viewer can see that session.

Relation to the desk. Phase 1 adds nothing to the desk. Phase 2 lets a person pin an artifact or app as a desk tile and in the sidebar.

### 2. How agents create, update and test artifacts

Five platform tools in a new `packages/mcp/src/tools/artifacts.ts`, registered like the wiki tools (`packages/mcp/src/tools/wiki.ts`). They reach every runtime through the existing `agentum` MCP server: Pi through `pi-run-mcp.ts`, Managed Agents through `mcp_toolset` in `managed/gateway.ts`, machines through `q.setMcpServers` in `apps/daemon/src/executor.ts`.

| Tool | Annotation | Does |
|---|---|---|
| `artifact_create` | `WRITE_CREATE` | New artifact with version 1. |
| `artifact_update` | `WRITE_UPDATE` | New version on `baseVersion`. Refuses a stale base with `conflict`. |
| `artifact_read` | `READ_ONLY` | Metadata, version list and the text of one file. |
| `artifact_list` | `READ_ONLY` | Artifacts the run may see. |
| `artifact_test` | `READ_ONLY` | Loads a version in Browser Run and reports what broke. |

The dry-run gate skips the two write tools with "Skipped in dry run: would …" (`register.ts`). "Ask me before" works with the keys `harbourmaster/artifact_create` and `harbourmaster/artifact_update` in all runtimes, and the profile shows them once they have entries in `PLATFORM_TOOL_LABELS` (`packages/services/src/agent-profile/ask-before.ts:38`).

`artifact_create` input:

```ts
{
  title: string;              // 1..120
  kind: "page" | "doc" | "dashboard";
  description?: string;       // up to 500
  message?: string;           // version note, up to 500
  // exactly one of:
  files?: { path: string; text?: string; base64?: string }[];
  fromLibraryPath?: string;   // a folder the run may read, usually its task folder
  entry?: string;             // default index.html, or index.md for doc
}
```

`artifact_update` takes `artifactId`, `baseVersion: number` and the same content fields, plus optional `title`. Both return:

```ts
{ artifactId: string; version: number; versionId: string;
  url: string;               // https://<app>/a/<artifactId>, needs sign-in
  files: number; bytes: number }
```

The result never contains a view token. Limits per version: 200 files, 10 MB per file (`LIBRARY_FILE_MAX_BYTES`), 16 MB in all (Claude's page cap). Paths are relative, without `..`, and must contain the entry. Content type comes from the extension, and unknown extensions are served as `application/octet-stream`.

Who may write: a run may create artifacts, and may update an artifact its own agent created. People can hand an artifact to another agent in phase 2. A run reads artifacts with audience `workspace` and the ones its agent created.

`artifact_test` input `{ artifactId, version?, viewport?: "desktop" | "phone" }`. The service mints a 5-minute test token for the run (never returned), opens the content URL in Browser Run through the existing driver (`apps/web/src/server/browser-run.ts`), waits for load, and returns as text: the page title, console errors and warnings (CSP violations show here), requests that failed or answered 4xx/5xx, a text snapshot of the page (`packages/services/src/browser/snapshot.ts`), and the library path of a screenshot saved in the run's task folder. The screenshot also becomes the version's thumbnail. Text results matter because Pi agents can't see MCP images (finding 2). Claude Code and Managed agents can open the screenshot file.

Agents on the Linux VM can also test logic with `bun test` on their own files before publishing. Installing Chromium in the VM is not part of this PRD (finding 3).

### 3. Hosting and isolation

This is the security core. Dom decided on 27 Oct 2026 that artifacts live on the app's own origin under a path with a UUID, the way claude.ai uses `claude.ai/artifacts/<uuid>`: `https://agentumbot.io/a/<uuid>` is the framed view, and the content is served under it. A dedicated subdomain may come later only if it proves necessary, and it is not in phase 1 or 2.

So the isolation has to come from the browser's sandbox, not from a second origin. The rule: untrusted HTML and JS always run in an opaque origin. They must never be able to read the app's cookies, DOM or storage, send credentialed requests to `/api/*` and read the answer, register a service worker, or navigate the top window.

#### What the content could steal

Clerk's `__session` cookie holds a session JWT that lives about a minute. Clerk's docs say it is set on the application's root domain and is not HttpOnly, because Clerk's client SDKs read it ([Clerk XSS leak protection](https://clerk.com/docs/guides/secure/best-practices/xss-leak-protection), [GitHub discussion #336](https://github.com/clerk/javascript/discussions/336)). Clerk says it uses `SameSite=Lax` ([Clerk cookies](https://clerk.com/docs/guides/how-clerk-works/cookies)), and the docs don't state the path, which is `/` in practice (to confirm in devtools in A.4's check). The long-lived `__client` cookie is HttpOnly and sits on the Frontend API domain, not the app's. Agentum's own code sets no cookie attributes: a search of `apps/web/src` for `SameSite`, `HttpOnly` and `__session` finds nothing, so Clerk's defaults are what ship.

A script running same-origin with the app could therefore read `__session` from `document.cookie` and call every tRPC procedure as the viewer for that minute, refreshing it as Clerk does. Any artifact that ever runs with the app's origin is a full account takeover for whoever opens it. Everything below exists to stop that.

#### Options

| Option | Effect | Verdict |
|---|---|---|
| A. Sandboxed iframe attribute only (`sandbox="allow-scripts"`) | Opaque origin inside the frame. Opening the content URL directly, or a link to it, runs the page same-origin with the session. | Not enough on its own. |
| B. `Content-Security-Policy: sandbox allow-scripts …` response header, without `allow-same-origin` | The document gets an opaque origin wherever it loads, top-level included. The repo already uses this header on `/files/:id` (`apps/web/src/server/routes/files.ts:57-60`). Supported by all current browsers, not in `<meta>` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)). | Required. |
| C. Both B and A, plus a redirect of top-level opens to the frame, path-scoped CSP sources and no CORS credentials | Each layer covers a different failure: B covers direct opens, A survives the frame navigating itself (iframe sandbox flags persist across navigations), the redirect keeps the Agentum frame around the content. | Picked. |
| D. `srcdoc` iframe with inlined content | No URL to open directly, but assets need inlining and the frame can't load relative files. | Rejected. |
| E. A subdomain or separate domain | Real origin isolation. | Deferred by Dom's decision. Triggers to revisit are below. |

#### The design

Content URL: `/a/<uuid>/c/<token>/<path>`, served by a Hono route in the main Worker, mounted before the TanStack fall-through in `apps/web/src/server.ts`. The token is an HMAC view token (section 6), so relative asset URLs carry it.

Every content response, success or error, passes through one header wrapper that sets:

- `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; script-src <base> 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com; style-src <base> 'unsafe-inline' https://fonts.googleapis.com; font-src <base> https://fonts.gstatic.com; img-src <base> data: blob:; connect-src <base>; media-src <base>; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors https://<app>`. `<base>` is the full URL of this version's content folder, `https://<app>/a/<uuid>/c/<token>/`. CSP host sources with a path ending in `/` match only that prefix, so a page can't load or fetch `/api/*`, `/files/*` or another artifact. `'self'` is not used anywhere in the policy. In an opaque-origin document it may match nothing, or more than intended, so explicit URLs are safer.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, max-age=300`.
- `Access-Control-Allow-Origin: *` without `Access-Control-Allow-Credentials`. A page in an opaque origin is cross-origin to its own files, so `fetch('data.json')` and module scripts need CORS. The wildcard can't carry cookies, and the token in the path is what grants access.

The route refuses before it serves:

- A request with `Sec-Fetch-Dest: document` (a top-level open) and a member or link token answers 302 to `/a/<uuid>`, without the token. Pasted content URLs always land in the Agentum frame with its owner line and warning label. Test tokens for Browser Run are exempt.
- A request with the `Service-Worker: script` header answers 403, and no content response ever sets `Service-Worker-Allowed`. An opaque origin can't register a service worker anyway, so this guards against a header slip.

Content paths skip `clerkMiddleware()` and the compose middleware. The route needs only the `FILES` bucket and the view-token key, and reads the version's manifest from R2. Skipping Clerk keeps its handshake redirects out of iframe loads and keeps the session machinery away from untrusted bytes.

The frame on `/a/<uuid>` embeds `<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" allow="clipboard-write">`. No `allow-same-origin`, `allow-popups`, `allow-modals`, `allow-downloads` or `allow-top-navigation`. Without `allow-modals`, a page can't raise a `prompt()` asking for a password over the app's URL. Links in a page go through the bridge (`ui/open-link`), which opens them in a new tab after the viewer confirms.

Every non-content response from the app gets `Content-Security-Policy: frame-ancestors 'none'` from a middleware in `server.ts`. The app has no such header today (thread sweep) and embeds nothing of its own. With it, an artifact that navigates its iframe to `/desk` gets a refused frame, not a live app page inside the viewer.

How each threat ends:

| Threat | What stops it |
|---|---|
| Read `__session` or other cookies | Opaque origin: `document.cookie` throws. |
| Read the app's DOM or storage | Opaque origin: no same-origin access to the parent; `localStorage`, `sessionStorage` and IndexedDB throw. |
| `fetch('/api/trpc/…')` with the viewer's session | `connect-src` allows only the content folder; the request would carry `Origin: null`, so the default `credentials: "same-origin"` omits cookies; the app sends no CORS headers, so the page can't read an answer; `csrf()` on `/api/trpc/*` refuses form-type posts from another origin (the comment above the tRPC mount in `server.ts`). |
| Credentialed subresource loads (`<img src="/files/…">`) | `img-src` limited to the content folder. Requests from an opaque-origin document count as cross-site for `SameSite=Lax`, so the cookie isn't sent on subresource loads (per the cookie spec; to confirm with probes in A.4 and A.11). |
| Register a service worker | Opaque origins can't; `worker-src 'none'`; the route refuses `Service-Worker: script`. |
| Navigate the top window to a fake login | No `allow-top-navigation` in either sandbox. |
| Post a form with typed data somewhere | `form-action 'none'`. |
| `prompt()` for a password | No `allow-modals`. |
| Open the content URL directly as a full page on the app's domain | 302 to the frame; and if a browser sends no `Sec-Fetch-Dest`, the CSP sandbox still gives an opaque origin. |
| Navigate its own iframe to an outside phishing page | Not blockable by CSP (`navigate-to` was dropped from the spec). The frame expects `ui/initialize` from the injected bridge after every iframe `load` event. When a load arrives without one, the frame blanks the iframe and shows "This artifact tried to leave its page" with Reload. |
| Read another artifact | Path-scoped CSP, no shared storage, and its content needs its own token. |

The bridge uses a `MessageChannel`. On the first `ui/initialize` the frame transfers one port to the page and talks only through that port. If the iframe navigates away, the port dies with the document, so the frame can never post data to a page that replaced the artifact. The frame still checks `event.source` on the initial message and validates every message with a zod schema from `@repo/protocol`.

Before anything else in `<head>`, the route injects `<script src="_hm/bridge.js">` with `HTMLRewriter`. `_hm/` is a reserved folder inside the content path that agents can't write to. Besides the bridge, it installs in-memory stand-ins for `localStorage` and `sessionStorage`, so libraries that touch them don't crash in an opaque origin. Docs are served through a platform viewer page that renders `index.md` inside the same sandbox.

There is one Worker. The main Worker serves the content routes, because the second origin that justified a separate Worker is gone, and the isolation lives in the browser. A second Worker would add a deploy and a wrangler config without adding a boundary. The one server-side rule that matters is that the content route sets its headers on every response, which one wrapper and a test over every status code enforce.

PR previews now work too. A preview serves content on its own `workers.dev` URL, with the same headers.

#### Residual risks, stated plainly

1. Same site, possibly same process. The content is same-site with the app. Chrome can put sandboxed iframes in their own process, but whether every browser Dom's viewers use does is unverified. Google's guidance is that the CSP sandbox alone may not stop Spectre-class attacks ([web.dev](https://web.dev/articles/securely-hosting-user-data)). A working side-channel attack could read the app page's memory, including the one-minute session JWT. This is the main thing a separate origin would buy.
2. Phishing on the real domain. Artifact content appears under `agentumbot.io` in the address bar. The frame label, the top-open redirect and the blocked modals reduce it, but a convincing fake inside the frame is still on our domain. Worse, if Google Safe Browsing or a mail filter flags one phishing artifact, it may flag the whole host, and the app goes down with it.
3. One missing header is a full compromise. If any content response, an error page, a redirect or a cached copy, reaches the browser without the CSP sandbox, that page runs same-origin with the session. The single wrapper, tests over every path and status, and `Cache-Control: private` (so no shared cache can strip or mix headers) are the defence, but it is a sharp edge.
4. Opaque origins limit what artifacts can do: no real `localStorage`, no IndexedDB, no service workers, no cookies of their own, no OAuth popups. Phase 1 pages and dashboards don't need them. Phase 2 storage goes through the bridge.
5. The cookie and fetch behaviour of opaque origins rests on the specs and on Chrome and Firefox probes. Safari can't be driven by the repo's browser tooling, so a person checks it by hand in A.11.

#### When to move content to a subdomain

Any one of these should trigger a separate content origin (a subdomain on a separate registrable domain, as in this PRD's first draft):

- A micro app needs real-origin features: its own cookies, IndexedDB, a service worker, WebAuthn or an OAuth popup.
- A header slip or a browser bug ever lets content run with the app's origin, in testing or in production.
- A Safe Browsing or mail-filter flag against the app's host caused by artifact content.
- Public listing (phase 4), or link shares reaching many outside viewers, which raises the phishing stakes.
- A security review that rates the shared-process risk as unacceptable for the data in the workspace.

The routes are ready for that move. The content path builder is one function, so moving content to `https://<uuid>.<content-domain>/c/<token>/…` changes that function, the CSP `<base>` and `frame-ancestors`, and adds a route. The data model doesn't change.

### 4. Data and tool access from inside an artifact

Options:

| Option | Keys in the page | Works for anonymous viewers | Verdict |
|---|---|---|---|
| Direct calls from the page to connector APIs | Yes | Leaks the owner's keys to everyone | Rejected. |
| A scoped bearer token handed to the page, which then calls an Agentum API | Token in page JS, readable by anything the page loads from a CDN | Would carry the owner's rights to anonymous viewers | Rejected. |
| Snapshot data shipped in the version | None | Yes, and the sharer sees what's in it | Phase 1. |
| A `postMessage` bridge to the app frame, which calls a tRPC procedure with the viewer's own session and the artifact's declared grants | None | No, by rule | Phase 2. |

Phase 1 dashboards read data files in their own version with relative `fetch('data.json')`, which the path-scoped `connect-src` allows. Freshness comes from the agent publishing a new version, often from a routine. The share dialog lists the data files in the version, so a person sharing a link sees what data leaves with it.

Phase 2 adds live calls through the bridge, modelled on MCP Apps and on Claude's artifact connectors:

- The version declares grants in `agentum.json`: which connector tools and platform read tools it may call, and with which argument limits.
- The page sends `tools/call` to the frame over the bridge's `MessageChannel` port. The frame calls `artifacts.callTool` over tRPC as the signed-in viewer (`workspaceProcedure`). The service checks the grant list, runs the tool through the existing credentials path with the viewer's own credential (`credentials.resolve` in `packages/services/src/credentials.ts:591`), and returns the scrubbed result.
- Only `readOnlyHint` tools can be granted in phase 2. A grant that a version adds or widens needs a person's approval, through the propose and approve flow skills already use.
- Link viewers get what the share allows (Dom's decision, 27 Oct 2026). The person who creates a link picks its data mode: `snapshot` (the default) or `live`. A snapshot link answers every `tools/call` with an error, so its viewers see only the data files in the version. A live link lets anyone holding it run a fixed list of read-only tools with the artifact owner's rights. This is the main exfiltration path, so the live mode carries the safeguards below as requirements (R2.6 and R2.10 to R2.15), not as defaults.

Live links, in detail:

- Only the artifact's owner can create a live link, because the calls use the owner's connections. An admin who isn't the owner can create snapshot links only. Nobody lends another person's rights.
- The share row records who granted it (`granted_by`) and the exact tool keys it may call (`live_tools`, in the `<serverKey>/<tool>` form of `packages/protocol/src/requests.ts`). The list is a subset of the version's declared grants and holds only tools with `readOnlyHint`. A later version that declares more tools widens no existing link.
- Every call is checked at call time, with no cache: the link isn't revoked or expired, the workspace switch is on, `granted_by` is still the owner and still a member of an allowed org, the tool is in `live_tools` and in the current version's grants, and the rate limits hold. Revoking the link therefore stops the next call at once.
- Calls run through the existing credentials path in `user` mode on behalf of `granted_by` (`credentials.resolve`, `packages/services/src/credentials.ts:591`). Results pass the event scrubber (`packages/services/src/events/scrub.ts`) and a size cap before they reach the page. Keys never leave the server.
- Rate limits per link: 60 calls a minute, 1,000 a day, and 10 a minute per visitor hash. They are tighter than the share-open limit.
- Every call, allowed or refused, writes an `artifact_views` row with surface `live_call`, the tool key, the outcome and the same IP prefix, place and browser fields as an open. The owner sees them in the link's access log.
- The person creating a live link chooses its expiry from the same choices as any link, including never (Dom, 27 Oct 2026). The dialog shows the expiry next to the live warning.

### 5. Server parts for micro apps (phase 2)

Options:

| Option | Fit | Cost | Verdict |
|---|---|---|---|
| Dynamic Workers (`LOADER`) | Already in production for skill scripts (`dynamic-worker-sandbox.ts`), no deploy step, code loaded from the version's files, capability bindings via `ctx.exports` with props (`script-host.ts`) | 1,000 unique Workers a month included, then $0.002 per Worker per day, plus normal request and CPU pricing. Open beta since 24 Mar 2026, no GA found. ([pricing](https://developers.cloudflare.com/dynamic-workers/pricing/), [changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/)) | Picked. |
| Workers for Platforms | Built for many tenants, an outbound Worker controls egress | $25 a month plus usage, a script upload per version, user Workers can't read `request.cf` without trusted mode ([pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/), [limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)) | Fallback if Dynamic Workers stall in beta. |
| Containers or the Linux VM | Full Linux | Cold starts, per-instance cost, no previews | Rejected for app servers. |

How it runs:

- The content route sends `/a/<uuid>/c/<token>/api/*` to an `AppGateway` module in the main Worker, with the verified token claims (artifact, version, viewer). It answers CORS preflights for that path with `Access-Control-Allow-Origin: *` and no credentials, because the page calls it from an opaque origin.
- `AppGateway` loads the version's `server/` bundle with `env.LOADER.get("app:<versionId>", …)`, so a version stays warm and a new version is a new Worker. Its `env` holds one binding, `HM`, made with `ctx.exports.AppHost({ props: { artifactId, versionId, viewer } })` as `ScriptHost` is today. `HM` offers storage, granted tool calls and a filtered `fetch`.
- `globalOutbound` is an outbound entrypoint that allows only hosts the app declares and adds secrets through placeholders, like `SecretsOutbound` (`apps/web/src/server/secrets-outbound.ts`). With no hosts declared it is `null`, which blocks the network ([egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)).
- Storage is one SQLite Durable Object per app, `AppStore`, with a per-viewer area and a shared area, reached only through `HM` from the server part or through the bridge from the page. Pages can't use the browser's own storage in an opaque origin. Durable Object Facets, which give dynamically loaded code its own SQLite that the supervisor's database can't see, are the alternative to evaluate in the phase 2 spike ([facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)).
- Limits: per-request CPU as the parent Worker, 50 subrequests (`MAX_SUBREQUESTS` in `dynamic-worker-sandbox.ts`), 20 MB of storage per app to start, the same as Claude's artifact storage.
- Secrets: an app names secrets from the vault; a person grants them, as `grant_secret` does for agents (`packages/mcp/src/tools/admin.ts`). Values never reach the app's code, only placeholders that the outbound entrypoint fills.
- Versions of apps go live only on promote. An agent publishes a version as `proposed`, tests it with `artifact_test` and `bun test`, and calls `artifact_promote`. A version that adds grants, secrets or hosts waits for a person in Needs you.
- Cost at Dom's scale is small. A few dozen apps and versions a month stay inside the included 1,000 Workers, and a few hundred MB in R2 costs cents a month.

### 6. Sharing, permissions and the access log

Share model:

| Level | Who opens | Phase | Notes |
|---|---|---|---|
| `private` | The owner, and workspace admins | 1 | Default for artifacts from `ui` and private sessions. |
| `workspace` | Every member of the workspace's Clerk org | 1 | Same gate as `workspaceProcedure`. |
| Link | Anyone with the URL, no sign-in | 1 | On top of either audience. Many links per artifact, each with its own expiry, optional version pin, revocable. From phase 2 each link is `snapshot` or `live` (section 4). |
| `people` | Named people, by email | 4 | Email one-time code through the existing `EMAIL` binding, or a Clerk account outside the org. |
| `public` | Anyone, listed in a public gallery, indexable | 4 | Workspace admin only. |

Rules:

- The owner and workspace admins (`isAdmin`, from Clerk `org:admin`, `workspaces.ts`) change the audience, create links and revoke links (Dom's decision, 27 Oct 2026). Only the owner creates a live link. Members see the list of links on artifacts they can open.
- Agents can't change audience or create links in phase 1. Phase 4 can add an `artifact_share` tool that always waits for a person's approval.
- Each workspace has a link-sharing switch, on by default, that only admins change. Turning it off blocks every existing link at once without deleting them, as Claude's org switch does. An environment variable `ARTIFACT_LINKS_OFF` blocks links everywhere, as an emergency stop.
- A link token is `hm_share_` plus 32 random bytes in base64url, and view tokens start `hm_view_`. The prefix matters: the event redactor already replaces any `hm_<kind>_<16+ chars>` string with `[redacted]` (`packages/services/src/events/redact.ts:35`), so a token that slips into a tool result or event is scrubbed anyway, and the bearer resolver already refuses unknown `hm_` prefixes (`workspaces.ts:325-333`). D1 stores its SHA-256 for lookup (`hashToken`, `crypto.ts:171`) and an AES-GCM copy under `SECRETS_KEY` (`encryptSecret`, `crypto.ts:123`) so the owner can copy the link again later. The token is never logged or put in events.
- A link either follows the artifact's current version or pins one version.
- Expiry choices: never, 1 day, 7 days, 30 days, or a date.

How it fits Clerk and authz. Members are resolved exactly as today: a Clerk session with an active, allowed organisation becomes a `user` principal (`sessionPrincipal`, `workspaces.ts:131-153`), and the artifacts service calls `authorize()` and then its own audience check. A link viewer is not a `Principal`. The share route resolves the token to a `ShareGrant` value (`{ workspaceId, artifactId, shareId, versionId }`) that only the artifacts service accepts. TypeScript keeps it out of every other service, and `can()` never sees it, because `can()` would wave through any principal with the right `workspaceId` (finding 1).

Opening flows:

- Member: `/a/$artifactId` calls `artifacts.open` (tRPC `workspaceProcedure` mutation), which checks the audience, records the view and returns metadata plus a member content URL.
- Link: `/s/$token` renders the frame, and its client calls `POST /api/share/:token/open`. That route is a Hono route in the artifacts lane, authenticated by the token in its path, the same class as the existing bearer routes. It checks the workspace switch, revocation and expiry, applies a rate limit, records the view with request metadata, and returns metadata plus a link content URL. Unknown, revoked, expired and disabled links all answer the same 404 body, so a caller can't probe which links once existed. The view row still records the outcome for known links.
- Logging the open on the client's POST, not on the SSR page load, keeps link unfurlers (Slack, email scanners) that don't run JavaScript out of the count. It still counts browsers that do.

The access log is a new `artifact_views` table, not `events`. Events are append-only with triggers that refuse DELETE, so they can't be pruned (`0000_init.sql:357-367`), they require an actor, and they suit management actions, not high-volume anonymous reads. Management actions do go to `events`: `artifact.created`, `artifact.published`, `artifact.restored`, `artifact.renamed`, `artifact.audience_changed`, `artifact.deleted`, `artifact.share_created`, `artifact.share_revoked`, `artifact.links_switched`.

What each view row keeps, and why:

| Field | Source | Why |
|---|---|---|
| time, artifact, version, share, surface (`viewer`, `thread`, `share`, `test`), outcome (`ok`, `revoked`, `expired`, `disabled`) | request | Who saw what, and opens of dead links |
| member user id | session | Members are known people |
| IP prefix: IPv4 /24, IPv6 /48 | `CF-Connecting-IP`, truncated before storage | Tells networks apart without storing an address |
| visitor hash: HMAC of full IP and user agent with a random daily salt | salt row deleted after 2 days | Counts distinct visitors per day, then can't be linked or reversed (Plausible's approach, [data policy](https://plausible.io/data-policy)) |
| country, region, city, ASN, AS organisation | `request.cf` ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/request/)) | "Opened from Sydney on the client's network" is the useful signal |
| user agent, cut to 256 characters | header | Browser and bot detection |
| referrer host only | header | Where a link travelled, without paths or tokens |

Lawfulness. Under the EU's *Breyer* ruling, a dynamic IP address can be personal data, and security logging can be a legitimate interest ([Bird & Bird](https://twobirds.com/en/insights/2016/global/cjeu-decision-on-dynamic-ip-addresses-touches-fundamental-dp-law-questions), [GDPR recital 49](https://gdpr-info.eu/recitals/no-49/)). Australia's Privacy Act covers information about a reasonably identifiable person, APP 11.2 requires destroying or de-identifying information once it's no longer needed ([OAIC](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-11-app-11-security-of-personal-information)), and the tranche 2 exposure draft (31 Aug 2026, not law) would bring IP addresses clearly into scope (secondary source, [Sparke Helmore](https://www.sparke.com.au/insights/a-new-era-for-privacy-in-australia-implications-of-privacy-act-reform-tranche-2/)). The design therefore never stores a full IP, tells link viewers in the frame that opens are logged, and deletes rows after 12 months (Dom's decision, 27 Oct 2026). No authoritative norm for view-log retention was found. The CNIL suggests 6 to 12 months for security logs ([CNIL](https://cnil.fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation)). This is not legal advice.

### 7. Versioning and Git sync (phase 3)

Mapping: one Git repository per workspace (or per app, Dom's choice), one folder per artifact named by a slug, one commit per version. The commit message is the version message, the author is the agent or person, and a trailer `Agentum-Version: <versionId>` ties the commit back. The version stores `source_commit_sha`, as skill versions do (`packages/db/src/schema/skills.ts`).

Direction, in two steps:

1. Push only. Each new version becomes a commit on a branch Agentum owns. This needs write access the platform lacks: today `GITHUB_TOKEN` is optional and used only to read (`compose.ts:926-928`). A GitHub App installation token per workspace is the clean way, and it is new work.
2. Pull. A change on the tracked branch becomes a `proposed` version that a person approves, reusing the skills importer: `resolve` (ref to sha) and `tree` (codeload tarball, subfolder, limits) in `apps/web/src/server/github-skill-source.ts`, a sparse `artifact_sources` table like `skill_sources` with `checked_at` polling from the tick (`apps/web/src/server/tick/automation.ts`), and an update notice in Needs you like `skill.update_available`.

There are no branches or merges inside Agentum. A pull on a stale base is refused like a stale `artifact_update`, and the person resolves it in Git.

### 8. UI

Navigation. A new "Artifacts" item in `mainNavItems` (`apps/web/src/components/shell/nav-registry.ts:26`), after Library.

Artifacts page `/artifacts`. A grid of cards: thumbnail (from `artifact_test`) or kind icon, title, owner, author agent, version number, updated time, and an audience badge (Private, Workspace, Link). Filters: kind, made by (agent or person), shared by link. On phones the grid becomes a single column of rows, following MB.2's stacked-row pattern (`docs/tasks/MB.2-mobile-tables-confirms.md`).

Thread card. A new `artifact` part in the thread fold (`packages/protocol/src/thread.ts`), rendered as a `data-artifact` part next to `request` and `attachment` (`thread-parts.ts:60-72`, `assistant-message-container.tsx:91-101`), after the tool call that made it. Desktop: title, kind icon, "v3", Open and a live preview iframe at 360 px tall, lazy-loaded, with a click-to-interact overlay so scrolling the thread doesn't get caught inside it. Phones (below `MOBILE_BREAKPOINT` 768, `apps/web/src/hooks/use-mobile.ts`): the thumbnail and an Open button, because the thread viewport is capped at `max-h-[60vh]` (`thread-container.tsx`). Tool names arrive with runtime prefixes (`mcp__harbourmaster__…`, `agentum_…`), so the card keys on the event, not on the tool name.

Task view. An "Artifacts" slot in the right column (`task-page.tsx:300-324`, `SlotCard` in `slots.tsx:12`) lists what the run published.

Framed viewer `/a/$artifactId`. A 44 px top bar: title (renameable by the owner), "by <owner> · made by <agent> in <task>", a version picker, Share, and a menu with Open full screen, Version history, Copy link, Download (zip of the version's files), Delete. The iframe fills the rest of the viewport (`100dvh`). On phones the bar keeps the title, Share and a menu button.

Version history. A sheet listing versions newest first: number, author, message, time, task link, with View and Restore. Restore asks to confirm and says it creates a new version.

Share dialog. On desktop a dialog, on phones a full-width bottom sheet capped to the viewport, per MB.1's dialog rules (`docs/tasks/MB.1-mobile-shell-global.md`). It has an audience switch (Private, Workspace), the list of data files in the current version, a "Create link" form (expiry, follow latest or pin this version), and the link list: created by, created, expires, opens, last opened, Copy, Revoke. From phase 2 the link form also has a data choice: "Snapshot only" (preselected) or "Live, using my connections", with tool checkboxes, none ticked, and a warning: "Anyone with this link can run these tools as you until it expires or you revoke it. Every call is logged." Live links show a "Live as <owner>" badge. Revoke asks to confirm, after the audit incident where a one-tap revoke deleted a desk key (`docs/reviews/mobile-audit/report.md`, "Incident").

Access log. A tab on the artifact page: time, link or member, place, network, browser, outcome, with a filter by link. Phones get stacked rows.

Share page `/s/$token`. A thinner bar: title, "Shared from <workspace> on Agentum", "Content is user-generated and unverified.", and "Opens of this link are logged." A dead link shows one plain page: "This link is not available."

Workspace setting. Settings gains an "Artifacts" section with the link-sharing switch (admins only).

### 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| XSS or session theft through artifact code | CSP `sandbox` header on every content response plus a sandboxed iframe, both without `allow-same-origin`; path-scoped CSP sources; no CORS credentials; content paths skip Clerk; `frame-ancestors 'none'` on the app. Link viewers are not principals. Residual risks are listed in section 3. |
| A flagged phishing artifact gets the app's host blocklisted | Only members create links, agents can't, links expire and can be switched off; a Safe Browsing or mail-filter flag is a trigger to move content to its own domain (section 3). |
| Phishing through shared links (the claude.ai FakeAgent case) | Content can't navigate the frame or run top-level; the frame always shows workspace, owner and "user-generated and unverified"; `noindex` everywhere; no downloads from the sandbox; only members create links; agents can't; links expire; the workspace switch and `ARTIFACT_LINKS_OFF` stop them all. A report button comes in phase 4. |
| A prompt-injected agent publishes a page that asks for credentials | Agents can't create links, so the page reaches only members, inside the labelled frame. `form-action 'none'`, the path-scoped `connect-src`, no `allow-modals` and no popups keep typed data inside the page. |
| Data exfiltration from a dashboard | Phase 1 has no live data. In phase 2 members' calls use their own rights. Link viewers get calls only on a live link, which only the owner creates, with a fixed list of read-only tools, rate limits, a required expiry, a per-call log and instant revocation. Grant changes need approval. Residual: CSP doesn't cover every channel (WebRTC, DNS prefetch, popups), so grants, not CSP, are the boundary. |
| A shared link leaks further than intended | Expiry, revocation, the access log with places and networks, and dead-link opens recorded. |
| Abuse of public links (scraping, load) | A Workers Rate Limiting binding on `/api/share/:token/open`, per token and per IP prefix. Content responses for one version are cacheable. |
| Cost | R2 storage at the existing bucket, a per-workspace artifact quota of 1 GB like `LIBRARY_MAX_BYTES`, Browser Run time per `artifact_test` (billed beyond included hours, `wrangler.jsonc` comment), and Dynamic Workers within the included 1,000 per month at this scale. |
| Moderation | Owners and admins delete artifacts and revoke links; soft delete keeps the record and stops serving at once; every management action is in `events`. |
| Dynamic Workers stay in beta | Phase 2 keeps the loader behind a port, as `SkillScriptSandbox` is (`sandbox-port.ts`), so Workers for Platforms can replace it. |

## Data model (sketch)

All tables carry `workspace_id TEXT NOT NULL` with a foreign key, as every table but `workspaces` does (`docs/HANDOVER.md`). Ids are ULIDs, except `artifacts.id`, which is a random UUID (`crypto.randomUUID()`) because it appears in URLs, as on claude.ai.

`artifacts`

| Column | Notes |
|---|---|
| id, workspace_id, created_at, updated_at | |
| title, description | |
| kind | `page`, `doc`, `dashboard`, `app` |
| audience | `private`, `workspace` (phase 4 adds `people`, `public`) |
| owner_user_id | nullable, Clerk user id |
| created_by_kind, created_by_id | `user` or `agent` |
| agent_id, session_id, run_id | nullable, foreign keys, where it was made |
| current_version_id | the version members see |
| thumbnail_key | nullable, R2 key |
| deleted_at, deleted_by | soft delete |

Index on `(workspace_id, updated_at)`.

`artifact_versions`

| Column | Notes |
|---|---|
| id, workspace_id, artifact_id, created_at | |
| number, parent_number | unique `(artifact_id, number)` |
| status | `published`; phase 2 adds `proposed`, `rejected` |
| message | |
| author_kind, author_id, author_run_id | |
| entry, file_count, total_bytes | |
| manifest_key | `<ws>/artifact-manifests/<id>.json` |
| source_library_path | nullable |
| source_commit_sha | nullable, phase 3 |
| thumbnail_key | nullable |

`artifact_version_files`: `version_id`, `path`, `sha256`, `size`, `content_type`, `workspace_id`, primary key `(version_id, path)`. Blobs at `<ws>/artifact-blobs/<sha256>`, garbage-collected on hard delete like skills' `unusedHashes`.

`artifact_shares`

| Column | Notes |
|---|---|
| id, workspace_id, artifact_id, created_at, created_by | |
| kind | `link` (phase 4: `person`) |
| token_hash | unique |
| token_encrypted | AES-GCM under `SECRETS_KEY` |
| version_id | nullable: null follows the current version |
| expires_at, revoked_at, revoked_by | |
| open_count, last_opened_at | updated on each open |
| data_mode | `snapshot` (default) or `live`, phase 2 |
| granted_by | Clerk user id of the owner who made a live link, null for snapshot |
| live_tools | JSON array of tool keys a live link may call, null for snapshot |

`artifact_views`

| Column | Notes |
|---|---|
| id, workspace_id, artifact_id, version_id, share_id, created_at | |
| surface, outcome | see section 6; phase 2 adds surface `live_call` and outcomes `refused`, `rate_limited`, `error` |
| tool_key | nullable, set for `live_call` rows |
| user_id | nullable |
| ip_prefix, visitor_hash | never a full IP |
| country, region, city, asn, as_org | from `request.cf` |
| user_agent, referrer_host | |

Indexes on `(artifact_id, created_at)` and `(share_id, created_at)`.

`artifact_view_salts`: `day` (primary key), `salt`. A tick job deletes salts older than 2 days and views older than the retention period.

`workspaces` gains `artifact_links_enabled` (boolean, default true).

Shared constants in `packages/db/src/shared.ts`: `ARTIFACT_KINDS`, `ARTIFACT_AUDIENCES`, `ARTIFACT_VIEW_SURFACES`, `ARTIFACT_VIEW_OUTCOMES`, `ARTIFACT_MAX_FILES = 200`, `ARTIFACT_MAX_BYTES = 16 MB`, `ARTIFACT_WORKSPACE_MAX_BYTES = 1 GB`, `ARTIFACT_VIEW_KEEP_DAYS = 365`, and the new `EVENT_TYPES`.

Phase 2 adds `artifact_grants` (version_id, kind `tool` or `secret` or `host`, target, status, decided_by) and the `AppStore` Durable Object.

## Interfaces

### Platform tools

See section 2 for inputs and outputs. Errors use the existing `ToolError` codes (`packages/mcp/src/result.ts`): `validation` (limits, paths, missing entry), `not_found`, `forbidden` (not the agent's artifact), `conflict` (stale `baseVersion`, with the current version number in the message).

### tRPC (`apps/web/src/server/trpc/artifacts-router.ts`)

All `workspaceProcedure`, thin over the services.

| Procedure | Input | Output |
|---|---|---|
| `artifacts.list` | `{ kind?, madeBy?, shared?, cursor? }` | `{ items: ArtifactCard[], next? }` |
| `artifacts.get` | `{ artifactId }` | metadata, owner, made-in task (if visible), current version |
| `artifacts.versions` | `{ artifactId }` | `Version[]` |
| `artifacts.open` | `{ artifactId, version?, surface }` | `{ contentUrl, expiresAt, version }`, records a view |
| `artifacts.restore` | `{ artifactId, version }` | `{ version }` |
| `artifacts.rename` | `{ artifactId, title }` | `{}` |
| `artifacts.setAudience` | `{ artifactId, audience }` | `{}` |
| `artifacts.remove` | `{ artifactId }` | `{}` |
| `artifacts.shares` | `{ artifactId }` | `Share[]` with copyable URLs |
| `artifacts.createShare` | `{ artifactId, expiresAt?, versionId? }` | `Share` |
| `artifacts.revokeShare` | `{ shareId }` | `{}` |
| `artifacts.views` | `{ artifactId, shareId?, cursor? }` | `{ items: View[], next? }` |
| `artifacts.setLinksEnabled` | `{ enabled }` | `{}`, admins only |

### HTTP routes

All in the main Worker, in a new artifacts route file mounted once in `apps/web/src/server.ts` before the TanStack fall-through.

- `POST /api/share/:token/open` (public, rate limited). Response 200: `{ title, kind, workspaceName, ownerName | null, agentName | null, version: { number, createdAt }, contentUrl, expiresAt }`. Response 404: `{ error: "This link is not available." }` for every refusal.
- `GET /api/artifacts/:id/thumbnail?version=<n>` (cookie session). `image/png` with the `/files` headers (`nosniff`, sandbox CSP).
- `GET /a/<uuid>/c/<token>/<path>`: the file, or the entry for an empty path, with the headers of section 3 on every status. 401 for a bad or expired token or a token for another artifact, 404 for a missing path, 302 to `/a/<uuid>` for a top-level open with a member or link token, 403 for `Service-Worker: script`. Skips `clerkMiddleware()`.
- `GET /a/<uuid>/c/<token>/_hm/bridge.js` and `_hm/doc.html`: platform files under the same headers.
- `OPTIONS` and `* /a/<uuid>/c/<token>/api/*`: phase 2 app server parts.
- `POST /api/share/:token/call` (phase 2, public, rate limited): `{ tool, arguments }` from the share frame for a live link. Response 200: `{ result }`, scrubbed. 403 `{ error }` for a tool outside the link or a snapshot link, 429 above the limits, 404 for a dead link.
- Every other response from the app gets `frame-ancestors 'none'`. `/a/<uuid>` and `/s/<token>` also get `Referrer-Policy: no-referrer`.

### Bridge (phase 1 subset, MCP Apps names)

Page to frame: `ui/initialize`, a size-change notification (exact name per the MCP Apps spec, to confirm in A.1), `ui/open-link { url }`. Frame to page: the initialize result with `{ theme: "light" | "dark", viewer: "member" | "link", version }`. Phase 2 adds `tools/call`, storage calls and `ui/message`.

## Requirements

Each line is a testable statement. "Must" means the phase isn't done without it.

### Phase 1: artifacts, the framed link, link sharing and the access log

Model and versions
- R1.1 An artifact has a title, kind (`page`, `doc` or `dashboard`), audience, owner, author per version and the session and run it was made in.
- R1.2 Each version is an immutable tree. Restoring version n creates version max+1 with n's files.
- R1.3 An update whose `baseVersion` isn't the current version fails with `conflict` and writes nothing.
- R1.4 A version over 200 files, 16 MB in all or 10 MB per file, or without its entry file, is refused with `validation`.
- R1.5 An artifact made in a `ui` or private session starts `private`; one made in any other session starts `workspace`; one a person publishes outside a session starts `private`.
- R1.6 A `private` artifact is listed and opened only by its owner and workspace admins. A run sees `workspace` artifacts and those its agent made.

Agent tools
- R1.7 `artifact_create`, `artifact_update`, `artifact_read`, `artifact_list` and `artifact_test` work from the cloud isolate, the Linux VM, Managed Agents and a machine.
- R1.8 `artifact_create` with `fromLibraryPath` publishes the folder's files the run may read, and refuses a folder outside its read scope with `not_found`.
- R1.9 A run may update only artifacts its agent created.
- R1.10 In a dry run, both write tools return "Skipped in dry run: would …" and write nothing.
- R1.11 An "Ask me before" rule on `harbourmaster/artifact_update` pauses the run for approval in every runtime.
- R1.12 `artifact_test` returns the console errors, failed requests and a text snapshot as text, saves a screenshot in the run's task folder, and sets the version's thumbnail.
- R1.13 No tool result, event payload or log line contains a view token or a share token.

Hosting
- R1.14 Every response under `/a/<uuid>/c/`, including errors and redirects, carries the CSP `sandbox allow-scripts allow-forms` without `allow-same-origin`, and the other headers of section 3.
- R1.15 A content request with a missing, forged or expired token, or with a token for another artifact, answers 401 and no bytes.
- R1.16 A top-level open of a content URL with a member or link token answers 302 to `/a/<uuid>`, without the token.
- R1.17 CSP sources in content responses are limited to the version's content folder and the CDN allowlist; a probe page can't load or fetch `/api/*`, `/files/*` or another artifact's path.
- R1.18 The viewer embeds content in an iframe with exactly `sandbox="allow-scripts allow-forms"`.
- R1.19 A probe artifact can't read `document.cookie`, `localStorage` or the parent DOM, can't send a request to `/api/trpc` that carries the session, can't register a service worker, can't navigate the top window, can't submit a form and can't call `prompt()`, when framed and when its URL is opened directly.
- R1.20 The frame talks to the page only through a `MessageChannel` port set up on `ui/initialize`, validates every message, and opens a link only after the viewer confirms.
- R1.21 An iframe `load` without a fresh `ui/initialize` blanks the frame and shows a warning.
- R1.21a Every non-content app response carries `frame-ancestors 'none'`, and content paths skip `clerkMiddleware()`.
- R1.21b A `doc` artifact renders its markdown inside the sandbox.

UI
- R1.22 A published artifact appears in the thread as a card with a live preview on desktop and a thumbnail on phones, live while the run streams and after a reload.
- R1.23 The task view lists the artifacts its run published.
- R1.24 `/artifacts` lists the artifacts the viewer may open, with filters for kind, maker and link sharing.
- R1.25 `/a/<id>` opens the artifact full screen with title, owner, version picker, share control and version history; `?v=<n>` opens an older version.
- R1.26 At 390 x 844 the viewer, the share sheet and the access log have no sideways scroll, and every control is at least 40 px.

Sharing and the log
- R1.27 The owner or an admin can create any number of links, each with an optional expiry and an optional pinned version, and can copy a link again later.
- R1.28 Opening a link in a fresh browser with no session shows the artifact inside the share frame, with the workspace name, the "user-generated and unverified" label and the logging notice.
- R1.29 After revoke, expiry or the workspace switch going off, the next open of the link answers 404 with the same body as an unknown token, and content requests with tokens minted for it fail within 1 hour.
- R1.30 Members other than the owner and admins can't create or revoke links, and no agent can.
- R1.31 Every open through the viewer, the thread preview, a link or `artifact_test` writes one `artifact_views` row; link opens include IP prefix, visitor hash, place, network and user agent; no row holds a full IP.
- R1.32 Opens of revoked, expired or disabled links write a row with that outcome.
- R1.33 A tick job deletes view rows older than the retention period and salts older than 2 days.
- R1.34 Creating and revoking links, changing audience, restoring, renaming, deleting and switching links off each write one event naming the person.
- R1.35 The share-open route is rate limited per token and per IP prefix and answers 429 above the limit.
- R1.36 `ARTIFACT_LINKS_OFF` set on a Worker stops every link open in that environment.

### Phase 2: live dashboards and micro apps

- R2.1 An `app` artifact can include `server/` code that runs in a Dynamic Worker per version, reached at `/a/<uuid>/c/<token>/api/*`.
- R2.2 App server code has no network unless the version declares hosts and a person approved them.
- R2.3 App storage is per app, with a per-viewer area and a shared area, capped at 20 MB, reachable only through `HM`.
- R2.4 An agent's app version is `proposed` until `artifact_promote`; a version that adds grants, secrets or hosts waits for a person in Needs you.
- R2.5 A page calls a granted read-only tool through the bridge, and it runs with the signed-in viewer's own credential.
- R2.6 On a snapshot link, a link viewer's `tools/call`, storage write or server call that needs a person's rights is refused.
- R2.10 Only the artifact owner can create a live link; the share records `granted_by` and `live_tools`, and `live_tools` accepts only read-only tools the current version declares.
- R2.11 A live link's call runs with `granted_by`'s credentials only while `granted_by` is the owner and a member of an allowed org; otherwise it is refused.
- R2.12 After a live link is revoked or expires, the next call is refused, with no caching in between.
- R2.13 A live link's calls are limited to 60 a minute and 1,000 a day per link and 10 a minute per visitor; above that they answer `rate_limited`.
- R2.14 Every live call, allowed or refused, writes one `artifact_views` row with the tool key and outcome.
- R2.15 The share dialog shows the data mode as a choice with snapshot preselected, lists the tools with none ticked, and shows a warning naming whose rights the link uses before it creates a live link; the person creating the link chooses the expiry, as for any link.
- R2.7 People can pin an artifact to the sidebar and as a desk tile.
- R2.8 Before R2.1 ships, a review checks the subdomain triggers of section 3 against phase 2's apps and records the answer.
- R2.9 A person can hand an artifact to another agent, which may then update it.

### Phase 3: Git sync

- R3.1 A workspace can connect a GitHub repo through a GitHub App installation, and each new version of a linked artifact becomes one commit with a `Agentum-Version` trailer.
- R3.2 A commit on the tracked branch becomes a `proposed` version within the update-check interval, and approving it makes it current.
- R3.3 A pull on a stale base is refused and shown in Needs you.

### Phase 4: richer sharing

- R4.1 Share with named people by email, who sign in with a one-time code.
- R4.2 A `public` audience lists the artifact in a workspace gallery, set only by admins.
- R4.3 An agent can ask to share, and the request waits for a person's approval.
- R4.4 Viewers can report an artifact; reports land in Needs you for admins.
- R4.5 Comments on artifacts for members.

## Phases

| Phase | Ships | Depends on |
|---|---|---|
| 1 | Static, doc and snapshot dashboard artifacts; agent tools with Browser Run testing; thread card, task slot, Artifacts page, framed link; private and workspace audiences; link sharing with expiry and revoke; access log; sandboxed content routes on the app's origin | Nothing outside the repo |
| 2 | Live dashboards through the bridge with viewer rights; micro apps with server parts, storage, grants, propose and promote; pins on desk and sidebar | Phase 1, a spike on Dynamic Workers and Facets, the subdomain review (R2.8) |
| 3 | Git sync, push then pull | Phase 2, a GitHub App |
| 4 | People and public sharing, agent share requests, reports, comments | Phase 1 |

## Phase 1 tasks

Ids are placeholders. The contract task A.1 alone changes `packages/db/src/schema`, `packages/db/src/shared.ts` and generates the migration, as the v2 rules require (`docs/v2/build-plan.md`, "Rules for parallel work"). Every new binding or var goes in three places in `apps/web/wrangler.jsonc` and lands in the worker lane. The domain spike and the separate content Worker of the first draft are gone. Their browser probes moved into A.4's check and the staging check.

| id | title | size | depends_on | lane | executor |
|---|---|---|---|---|---|
| A.1 | Artifacts contract | M | none | db | claude |
| A.2 | Artifacts service and router | L | A.1 | services | codex |
| A.3 | Shares, view tokens and access log service | M | A.2 | services | codex |
| A.4 | Sandboxed content routes and bridge script | L | A.1 | worker | claude |
| A.5 | Artifact MCP tools | M | A.1 | mcp | codex |
| A.6 | Wiring, share route, test driver and tick | L | A.2, A.3, A.4, A.5 | worker | claude |
| A.7 | Thread fold for artifacts | S | A.1 | mcp | codex |
| A.8 | Artifacts page and framed viewer | L | A.6 | web | claude |
| A.9 | Thread card and task slot | M | A.7, A.8 | web | claude |
| A.10 | Share dialog, share page and access log | M | A.9 | web | claude |
| A.11 | Phase 1 staging check | M | all A tasks | worker | claude |

Scope and check per task:

**A.1 Artifacts contract.** Scope: the five tables and `workspaces.artifact_links_enabled` in `packages/db/src/schema/artifacts.ts`, with `artifacts.id` a UUID; migration with `migrations/meta`; constants, types and `EVENT_TYPES` in `shared.ts`; `packages/protocol/src/artifacts.ts` with the view-token claim schema, the content path builder, and the phase 1 bridge message schemas (confirm MCP Apps names). Check: `schema.test.ts` and `foreign-keys.test.ts` cover the tables, protocol tests parse every bridge message and token claim, the `events` triggers survive, `bun run check && bun run test && bun run build` pass.

**A.2 Artifacts service and router.** Scope: `packages/services/src/artifacts/` factory over `{ db, atomic, blobs, clock, events, library }`: create, update with base check, content-addressed blob and manifest writes, `fromLibraryPath` through the library service's read rules, limits, list, get, versions, read file, restore, rename, audience, soft delete, the audience and agent rules of R1.5, R1.6 and R1.9, events with session and run; `artifacts-router.ts` for the procedures except shares and views. Check: unit tests for R1.2 to R1.6, R1.8, R1.9 and the events of R1.34 against `bun:sqlite`; router tests for 401 and 403.

**A.3 Shares, view tokens and access log service.** Scope: `hm_view_` token sign and verify in an entry that imports no drizzle; `hm_share_` link create (hash plus encrypted copy), list, revoke, expiry, pinned version, workspace switch (admins), open for members and links with view recording, IP truncation, daily salts, 12-month prune; `PLATFORM_TOOL_LABELS` entries for the artifact write tools; router procedures for shares, views and the switch. Check: tests for R1.27, R1.29 to R1.34 and R1.13, including a type test that a `ShareGrant` can't be passed where a `Principal` is expected, and that no stored row or event holds a token or a full IP.

**A.4 Sandboxed content routes and bridge script.** Scope: a Hono route module under `apps/web/src/server/artifact-content/` for `/a/<uuid>/c/<token>/*`: token check, manifest and blob reads from R2, one header wrapper for every response, the `Sec-Fetch-Dest` redirect, the `Service-Worker` refusal, `HTMLRewriter` injection of `_hm/bridge.js`, the bridge script with its `MessageChannel` and storage stand-ins, and the markdown viewer. Not mounted yet. Check: route tests for R1.14 to R1.17 over every status code; a browser probe in Chrome and Firefox against a local dev server for R1.19, framed and opened directly, with the cookie result recorded in `docs/reviews/tasks/A.4.md`; `bun run check && bun run test && bun run build` pass.

**A.5 Artifact MCP tools.** Scope: `packages/mcp/src/tools/artifacts.ts` with the five tools, ports in `packages/mcp/src/ports.ts`, annotations, descriptions that tell agents to use relative paths and to test, registration in `server.ts`. Check: tool tests for schemas, annotations, the dry-run text (R1.10) and error codes; `tools.test.ts` lists the new names.

**A.6 Wiring, share route, test driver and tick.** Scope: build both services in `composeWith` and add them to `Services`; merge the router in `router.ts`; in `server.ts`, mount the content routes and the artifacts routes, skip `clerkMiddleware()` and compose for content paths, and add the `frame-ancestors 'none'` middleware (R1.21a); `POST /api/share/:token/open` and the thumbnail route; MCP port adapters; the `artifact_test` driver over `browser-run.ts`; `artifact.published` in `STREAM_EVENT_TYPES`; tick jobs for view and salt pruning; var `ARTIFACT_LINKS_OFF`, secret `ARTIFACT_VIEW_KEY` and a rate-limit binding, each in three places. Check: route tests for R1.29, R1.35, R1.36 and R1.21a; an MCP round trip from a run token through `artifact_create` and `artifact_test` with a fake browser driver; `compose.test.ts` passes.

**A.7 Thread fold for artifacts.** Scope: `packages/protocol/src/thread.ts` folds `artifact.published` into an `artifact` part after the tool call that made it, in both `foldThread` and `applyFrame`. Check: fold tests for replay, live frames, dedupe and a reload mid-run.

**A.8 Artifacts page and framed viewer.** Scope: nav item; `/artifacts`; `/a/$artifactId` outside `_app` with the top bar, version picker, history sheet with restore confirm, rename, delete confirm, audience switch, the iframe, the bridge's frame side and the load-without-initialize warning (R1.20, R1.21); mobile layout. Check: component tests for the bridge handler; browser check at 1280 x 800 and 390 x 844 (R1.24 to R1.26).

**A.9 Thread card and task slot.** Scope: `data-artifact` part in `thread-parts.ts` and `assistant-message-container.tsx`, the card with lazy preview and click-to-interact overlay, thumbnail on phones, the Artifacts slot in `task-page.tsx`. Check: tests for the part mapping; browser check that a run's artifact shows live and after reload (R1.22, R1.23).

**A.10 Share dialog, share page and access log.** Scope: the share dialog and phone sheet with data-file list, link form and list with revoke confirm; `/s/$token` outside `_app` with labels and the dead-link page; the access log tab; the admin switch in Settings. Check: browser check in a fresh profile with no session (R1.28), revoke then reopen (R1.29), and the log rows shown (R1.31).

**A.11 Phase 1 staging check.** Scope: deploy to staging; one agent per runtime makes a page, a doc and a dashboard and tests them; open each from the thread, the task view, `/artifacts` and at phone width; run the probe artifacts of R1.19 framed and opened directly, in Chrome through agent-browser and in Safari by hand (Dom or the controller); create, open, revoke and expire links from a fresh browser; turn the switch off; read the log. Record results in `docs/reviews/tasks/A.11.md`. The minute tick runs only on the production Worker (`wrangler.jsonc`, crons comment), so R1.33's pruning is checked by its unit tests, not on staging. Check: every R1 requirement has a pass line with evidence.

Running sets, at most one task per lane at a time:

1. A.1 (db)
2. A.2 (services), A.4 (worker), A.5 (mcp)
3. A.3 (services), A.7 (mcp)
4. A.6 (worker)
5. A.8 (web)
6. A.9 (web)
7. A.10 (web)
8. A.11 (worker)

The web lane (A.8 to A.10) is the critical path. 11 tasks, 4 on Codex (A.2, A.3, A.5, A.7).

## Decisions

- 27 Oct 2026, Dom: artifacts live on the app's origin under `/a/<uuid>`, with the content under that path. No separate content domain in phase 1 or 2. A subdomain comes later only if a trigger in section 3 fires.
- 27 Oct 2026, Dom: the default audience follows the session. Artifacts from web chat and Slack DMs start private to the person who opened the session, and the rest start workspace-wide.
- 27 Oct 2026, Dom: the access log keeps rows for 12 months, with IPv4 /24 and IPv6 /48 prefixes and a daily-salted visitor hash, and never a full IP.
- 27 Oct 2026, Dom: the owner and workspace admins create and revoke links. Agents never create links in phase 1. A workspace switch for link sharing is on by default.
- 27 Oct 2026, Dom: from phase 2, the person who creates a link chooses per link between snapshot only and live with the owner's rights. The live option records who granted it and which tools it may call, shows a warning in the share dialog, is rate limited, logs every call in the access log and stops at once on revoke (section 4).
- 27 Oct 2026, Dom: agent versions of pages, docs and dashboards go live at once, and restore undoes a bad one. App versions that ask for new grants wait for a person.
- 27 Oct 2026, Dom: artifacts get 1 GB of storage per workspace, and no copy goes into the library.

## Open questions for Dom

None at the moment. Phase 2 starts with a spike on Dynamic Workers and Durable Object Facets and the subdomain review (R2.8), which may raise new ones.
