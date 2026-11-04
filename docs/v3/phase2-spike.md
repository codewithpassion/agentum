# Phase 2 spike: Dynamic Workers, app storage and the subdomain review

Task B.1, 27 Oct 2026. Spec: `docs/v3/artifacts-prd.md` sections 3 to 5. The throwaway Worker, bundles and logs are in `/home/roboto/devel/harbourmaster-wt/tmp/B.1/` (`spike/src/index.ts`, `spike/bundles/*`, `wrangler-dev*.log`, `vite-dev.log`). Versions: wrangler 4.151.1, `@cloudflare/vite-plugin` 1.64.0, compatibility date `2026-08-19` with `nodejs_compat`, the same as `apps/web/wrangler.jsonc`.

## Decisions

| Question | Answer |
|---|---|
| Storage | `AppStore`, one SQLite Durable Object per artifact. Not Facets. |
| Loader | `env.LOADER.get("app:<versionId>", …)` works as the PRD says, with one change: the viewer must not be baked into the cached Worker (Q2). |
| Network | `globalOutbound: null` blocks `fetch` and `connect`. An outbound entrypoint with a host list works, and it reads the approved hosts at call time. Skip `AgentumHost.fetch`: global `fetch` through the gateway already is the filtered fetch. |
| Local dev | All of it behaves the same under `wrangler dev` and `vite dev`. |
| R2.8 | No trigger fires for phase 2 as scoped. Stay on the app origin. One trigger waits on Dom (see R2.8). |

## Q1. Loading a bundle from files

Run: the spike seeds `server/index.js` files into R2 and reads them back as the `modules` of a `LOADER.get("app:<id>", cb)` call, then calls `getEntrypoint().fetch()` three times.

- A small ES module with `export default { fetch }` loads and serves. The module map is keyed by path, so `import "./lib/greet.js"` in `server/index.js` resolves to `server/lib/greet.js`, and a `.json` file imports as `{ json }`. Files must be mapped by extension (from the docs' module types, and `script-bundle.ts` does it; the spike's reader maps `.json` to `{ json }`).
- Warm reuse: three calls with the same id gave `hits` 1, 2, 3 (module state survives) and the callback ran once. A new id is a new Worker, which is how a new version loads. First call took 7 to 38 ms locally, warm calls 0 to 1 ms.
- Bad bundles never fail at `get()`. The stub is lazy and the first `fetch` throws `Failed to start Worker: …` with file, line and column. Four cases:

| Bundle | Error text |
|---|---|
| Syntax error | `Uncaught SyntaxError: Unexpected token '}' at server/index.js:1:24` |
| Throws at top level | `Uncaught Error: boom at top level at server/index.js:1:7` |
| No default export | `Incorrect type for map entry 'x': … not of type 'function or ExportedHandler'` |
| Missing import | `No such module "server/nope.js" imported from "server/index.js"` |

- With the harness of Q2 a bundle with no default export no longer fails at start: it fails at call time with `app.fetch is not a function`.
- A handler that throws makes `fetch` reject on the host with the app's message. It is an exception, not a 500 `Response`.
- TypeScript and bare npm imports are not resolved (from the docs' `modules` reference, not run). The module map takes JavaScript only. `buildModules` in `skill-scripts/script-bundle.ts` already strips TypeScript and maps JSON and data files, but its `wrapEntry` rewrites the entry into a function, so B.2 needs a no-wrap option. Agents must pre-bundle npm dependencies.
- CPU limit: a 5 s busy loop with `limits: { cpuMs: 1000 }` returned 200 after 5 s locally. The limit is not enforced in local dev, so B.2's tests must not rely on it. Keep a wall-clock timer like `dynamic-worker-sandbox.ts` does.

Consequences for B.2: when the version is published, parse every `server/` file with acorn and check that the entry has a default export with `fetch`, so a bad bundle is refused at publish and not at a viewer's first request. Catch the rejection at the gateway and answer 502 with a fixed body, never the app's message.

## Q2. AppHost over RPC, and the viewer problem

Run: `ctx.exports.AppHost({ props })` as `env.AGENTUM` in the loader config, called from the loaded code.

- It works. The app called `AgentumHost.whoami()`, `AgentumHost.kvPut()` and `AgentumHost.kvGet()` over RPC and the host wrote through the `AppStore` DO. `Object.keys(env.AGENTUM)` is empty, so the app holds a stub and cannot read the props.
- **Baked props are wrong for viewers.** `get(id, cb)` runs the callback once per id, so `env.AGENTUM` keeps the props of whoever loaded the Worker first. Requests for `viewer=alice` then `viewer=bob` both answered `viewer: "alice"`. The same happens to a facet's `env`. Putting the viewer in the loader callback would hand the first viewer's rights to everyone after.
- **Fix, tested.** The platform adds a generated main module (`__harness.js` in the spike) that imports the app's `server/index.js` and exports `class Harness extends WorkerEntrypoint { handle(request, agentum) { return app.fetch(request, { ...this.env, AGENTUM: agentum }, this.ctx) } }`. The gateway makes a fresh `AgentumHost` stub per request, `ctx.exports.AppHost({ props: { …, viewer } })`, and passes it as an RPC argument: `worker.getEntrypoint("Harness").handle(request, agentum)`. Alice then bob gave `viewer: "alice"` then `"bob"` on one cached Worker. The `Request` goes in and the `Response` comes back over RPC. The app author still writes `export default { fetch(request, env) }` and reads `env.AGENTUM`.
- A review spot-check kept a stub in module state and used it on a later request: it failed with `Cannot perform I/O on behalf of a different request`, and `dup()` is not callable over RPC. So a stub is bound to its request. The residual case is app code handing work through module state to a concurrent request that holds a stub with more rights; that is the app's own isolate and its own users.
- `getEntrypoint("Harness", { props })` also works and shows up as `this.ctx.props` in the harness (tested, returned `{ viewer: "carol" }`), but props must not carry the viewer's rights, only the stub does.
- Every public method of `AppHost` is callable by the app. Keep helpers `#private` and expose only the interface below.

## Q3. Network

Run: the same app fetches `https://example.com/` and `https://blocked.test/`, and opens a socket.

- `globalOutbound: null`: both `fetch` calls and `connect()` throw `This worker is not permitted to access the internet via global functions like fetch()…`.
- With `ctx.exports.Outbound({ props: { hosts: ["example.com"] } })` (the spike's class; B.8 names it `AppOutbound`): `example.com` returned 200, `blocked.test` got the gateway's own 403. Sockets do not go through `fetch`: the wrangler log says `Handler does not export a connect() function`, and one run failed at the proxy step. B.2 should leave `connect` unexported or refuse it.
- A bundle's response headers pass through untouched, which matters for the content route. A test app returned `Set-Cookie: __session=evil; Domain=rockyshoreslabs.io; Path=/`, `Clear-Site-Data`, `Service-Worker-Allowed: /` and `Access-Control-Allow-Origin: https://evil.test`, and the host received all four. B.2 must copy only an allowlist of response headers (`content-type`, `content-length`, `content-encoding`, `cache-control` bounded, `etag`, `vary`) and then set the A.4 content headers, which overwrite the app's, `Cache-Control` included (the app can never send `public`). Set-Cookie from app code would otherwise be set on the app's own domain.

## Q4. Storage: AppStore against Facets

Run: `AppStore` is a SQLite DO with one `kv(area, viewer, k, v)` table, reached through `AppHost` (`env.APP_STORE.getByName(artifactId)`). The facet side is a supervisor DO `AppRunner` with `ctx.facets.get("app", …)` loading an exported `App extends DurableObject` class from an R2 bundle.

- Facets work in local dev (`wrangler dev` and `vite dev`) at wrangler 4.151.1 and compatibility date 2026-08-19, with no extra flag. The docs page was updated 12 Oct 2026. `facets.delete("app")` emptied the database.
- **Cap.** In `AppStore`, `ctx.storage.sql.databaseSize` plus the incoming value is checked before each write. Filling the shared area in 1 MB values refused write 20 at 19,968,000 bytes with `quota_exceeded`. That is within one value of 20,971,520, so the cap holds. A facet got no cap: its own code wrote 26,263,552 bytes with no error, the supervisor's `databaseSize` stayed at 16,384, and I found no supervisor-side API for the facet's size or a limit.
- **Viewer and area rules.** In `AppStore` the host decides the viewer from the verified token, so the app cannot forge it. In a facet the app's own SQL decides: my test facet took the viewer from a query parameter and, because it reads every row with no viewer filter, returned alice's rows to bob. Its `env.AGENTUM` also kept alice (the Q2 caching). R2.3 (reachable only through `AgentumHost`) and R2.6 (a snapshot link never writes) would rest on the app author's code.
- **Pages without a server part.** The bridge calls storage with no server code loaded (R2.5 dashboards, B.5's storage procedures). A facet needs an exported class, so those apps would need a platform-written one anyway.
- **Platform control.** `AppStore` gives the platform size, export, wipe and per-viewer delete with plain SQL (size and writes ran, wipe did not). A facet's data is readable only through the app's code.
- Facets would be the better fit if apps needed arbitrary SQL, joins or their own schema. R2.3 asks for a key-value store with two areas, so that is not needed now. If a later phase wants SQL, add a facet beside `AppStore` for that app kind. Nothing in the `AgentumHost` interface below blocks it.

Pick: `AppStore`, keyed by artifact id so data survives versions. Cost is DO pricing either way.

## The `AgentumHost` interface (B.2 and B.3 build to this)

```ts
/** From the verified content token, never from app code. */
export type AppViewer =
  | { kind: "member"; userId: string }
  | { kind: "link"; shareId: string; dataMode: "snapshot" | "live" };

/** For R2.13 and R2.14: the 10-a-minute visitor limit and the `artifact_views` row on every call. Filled by the gateway from the request. */
export interface AppRequestMeta {
  visitorHash: string;
  ipPrefix: string | null;
  place: string | null;
  userAgent: string | null;
}

export interface AppHostProps {
  artifactId: string;
  versionId: string;
  workspaceId: string;
  viewer: AppViewer;
  meta: AppRequestMeta;
}

export type StorageArea = "viewer" | "shared";

/** The `env.AGENTUM` an app server sees. Every call is an RPC to `AppHost`. Values are JSON text, so the app calls JSON.stringify and parse. */
export interface AgentumHost {
  whoami(): Promise<{ viewer: "member" | "link"; dataMode: "snapshot" | "live" | null }>;
  getItem(area: StorageArea, key: string): Promise<string | null>;
  /** Refuses with `forbidden` when the viewer may not write the area, and `quota_exceeded` above the cap. */
  setItem(area: StorageArea, key: string, value: string): Promise<void>;
  deleteItem(area: StorageArea, key: string): Promise<void>;
  listItems(area: StorageArea, prefix?: string, limit?: number): Promise<{ key: string; value: string }[]>;
  /** A granted read-only tool, by `<serverKey>/<tool>`. Goes through B.5's call service. Link viewers on snapshot links get `forbidden`. */
  callTool(toolKey: string, args: unknown): Promise<unknown>;
}

export type AppErrorCode = "forbidden" | "quota_exceeded" | "not_granted" | "rate_limited" | "too_large";
```

`AppHost extends WorkerEntrypoint<Env, AppHostProps>` implements `AgentumHost` and holds the ports below. For a member it builds a fresh `Principal` per call and re-checks membership (B.5's `callTool` takes a `Principal`). For a link viewer `callTool` goes through B.6's `ShareGrant` entry, not B.5's member path, with `meta` for the limits and the access-log row. Because the claims come from the content token, `AppHost` re-checks the share (revoked, expired, switch off) on every storage write and tool call, as R2.12 requires for calls. Errors cross RPC as `Error` with the code as `message` prefix (`quota_exceeded: …`), as the spike's `AppStore` threw them.

The storage port is what B.3 implements and B.2 (`AppHost`) and B.5 (tRPC storage procedures, bridge) call. It is the only place that touches the DO.

```ts
/** `viewerKey` is `u:<userId>` for members and `l:<shareId>` for link holders. */
export interface AppStoreScope {
  artifactId: string;
  area: StorageArea;
  viewerKey: string;
}

export interface AppStorePort {
  get(scope: AppStoreScope, key: string): Promise<string | null>;
  set(scope: AppStoreScope, key: string, value: string): Promise<void>; // quota_exceeded
  delete(scope: AppStoreScope, key: string): Promise<void>;
  list(scope: AppStoreScope, prefix: string, limit: number): Promise<{ key: string; value: string }[]>;
  usage(artifactId: string): Promise<{ bytes: number; maxBytes: number }>;
  wipe(artifactId: string): Promise<void>; // artifact deleted
}

/** One pure function so AppHost and B.5 apply the same rule. */
export function canWrite(viewer: AppViewer, area: StorageArea): boolean;
```

Reads: members read both areas, and so do link viewers (snapshot links read the shared area, per B.3). All holders of one link share the single `l:<shareId>` viewer area and see each other's writes. B.3 owns `canWrite` and its tests, and `AppHost` and B.5 must call it before every `set` and `delete`, since the port does not check it.

Proposed `canWrite` (R2.6 fixes only the first line, the rest is my default for Dom to confirm): members write both areas; a link viewer on a snapshot link writes nothing; a link viewer on a live link writes only the `viewer` area (`l:<shareId>`), never `shared`. In the `shared` area `viewerKey` is ignored. Proposed value limit: 1 MB, key at most 256 bytes (not tested; a DO SQLite row holds up to 2 MB).

`AppStore` as run in the spike: `kv(area, viewer, k, v, primary key (area, viewer, k))`, `shared` rows stored with `viewer = ""`, size check as above. B.3 should count UTF-8 bytes of key plus value net of the row replaced (the spike used `v.length` and ignored the replaced row), and make `wipe` run `DELETE FROM kv` (the spike's `deleteAll()` drops the table, which only the constructor creates). Add `updated_at` for B.9's UI if wanted.

## Rules for the gateway

1. Cache id `app:<versionId>`, loader config with no viewer data in it.
2. Per request: new `AgentumHost` stub, `getEntrypoint("Harness").handle(request, agentum)`.
3. Header allowlist on the response (Q3), then the A.4 wrapper. Catch a rejection and answer 502 with a fixed body.
4. Publish-time parse of `server/` files; module type by extension.
5. `globalOutbound` is always `ctx.exports.AppOutbound({ props: { workspaceId, artifactId, versionId } })` with no host list in the props, because the loader config is cached per version and approvals happen after load (B.4's decideGrant, `artifact_test` on proposed versions). `AppOutbound` reads the approved hosts through the grants port on each request, refuses everything when there are none, and fills secret placeholders like `SecretsOutbound`.
6. Limits: set `limits.subRequests: 50`, plus a wall-clock timer (the CPU limit is not enforced locally). Docs of 28 Aug 2026: a DO can have 10 distinct Dynamic Workers in flight, any other Worker 4 per request. One app per request is far inside both.

## Q5. Local `vite dev`

Run: the same spike under `vite dev` with `cloudflare()` from `@cloudflare/vite-plugin`, the plugin `apps/web/vite.config.ts` uses, after a full `wrangler dev` pass. Load and warm reuse, the bad bundle text, per-request `AgentumHost`, `null` and allowlist outbound, the `AppStore` cap and the facet all gave the same answers as `wrangler dev`, read from the curl output at the time (bodies were not saved to a log). Skill scripts already depend on the same runtime (`pi-run.ts` calls `dynamicWorkerSandbox(this.env.LOADER, …)`). The `local-worker-loader.ts` stand-in is for `bun test` only and cannot run an RPC `AgentumHost` or a DO, so B.2's real-loader test needs `wrangler dev` or `vite dev` or Miniflare, as the task says. Caveat: the CPU limit (Q1) and `connect()` (Q3) differ from production.

## Wrangler entries for B.8

- `worker_loaders` `LOADER` exists in all three places, no change.
- Add the binding `{ "name": "APP_STORE", "class_name": "AppStore" }` to `durable_objects.bindings` at the top level, in `env.staging` and in `env.staging.previews`.
- Add `{ "tag": "v7", "new_sqlite_classes": ["AppStore"] }` to the top-level `migrations` only, after `v6`.
- Export `AppHost`, `AppOutbound` and `AppStore` from `apps/web/src/server.ts`, like `ScriptHost` and `SecretsOutbound`. `ctx.exports` needs no wrangler entry.
- Run `bun run cf-typegen` so `Env` has `APP_STORE`.
- The live-call rate-limit binding (R2.13) is B.6 and B.8's, in the same three places.
- Unchanged: `compatibility_date` stays at `2026-08-19` for both the Worker and the loader config.

## R2.8. Subdomain triggers against phase 2 apps as scoped

| Trigger (PRD section 3) | Phase 2 as scoped | Verdict |
|---|---|---|
| App needs real-origin features: cookies, IndexedDB, service worker, WebAuthn, OAuth popup | Pages stay in the opaque origin. State goes through `AgentumHost` and the bridge, the server part is reached by `fetch` with the token in the path, tools are granted without a popup, and an app wanting OAuth does it server-side with approved hosts and secret placeholders. | Not triggered. An app that needs offline storage or WebAuthn is out of scope and would trigger it. |
| A header slip or browser bug lets content run with the app origin | A process trigger, not scope. Phase 2 adds a second source of responses, app code, whose headers are app-chosen (Q3). | Not triggered. B.2 must allowlist headers, and A.4's every-status test must also cover `/api/*`, 502s and OPTIONS. |
| Safe Browsing or mail-filter flag against the host | Not caused by phase 2 scope. Server parts with approved hosts can send traffic from our network, which is already gated by host approval (R2.2). | Not triggered. |
| Public listing (phase 4), or link shares reaching many outside viewers | No listing in phase 2. Live links (R2.10 to R2.15) let anyone with a link run read-only tools with the owner's rights, which raises the cost of a phishing page more than phase 1 did. | Not triggered by scope. Re-check when live links go to many outside viewers, or before phase 4. |
| A security review rates the shared-process risk unacceptable for the workspace's data | Phase 2 puts live data in the page, but in the opaque-origin frame, not the app page whose memory the risk (residual risk 1) concerns. Server code runs in V8 isolates with no network by default. | Not for me to settle. Needs Dom, since it depends on how sensitive the connected data is. |

Verdict: R2.8 is done, pending Dom's call on the shared-process trigger (open question below). Phase 2 as scoped needs no subdomain, and the content path builder stays the single place to change if one is ever needed.

## Not run

Production behaviour of the CPU limit and `connect()`; `AppStore.wipe()`; eviction of a warm Worker (the callback re-runs and re-reads R2, so the manifest read must stay cheap); a browser round trip through `/api/*` with CORS preflights from an opaque origin (A.4 and B.8 cover that); Workers for Platforms.

## Open questions for Dom

1. Do link viewers on live links write the `viewer` area (proposed), or nothing?
2. Is the shared-process risk acceptable for the data phase 2 apps will show (R2.8, fifth trigger)?
