// biome-ignore-all lint/performance/noAwaitInLoops: ordered integration scenario and migrations.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd integration runner.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const directory = await mkdtemp(join(tmpdir(), "live-production-"));
let externalImageRequests = 0;
const options = {
  bindings: {
    ALLOWED_ORG_IDS: "org_w1",
    ARTIFACT_LINKS_OFF: "",
    ARTIFACT_VIEW_KEY: "production-integration-private-test-key",
    CLERK_SECRET_KEY: "sk_test_fixture",
    MAIL_DOMAIN: "",
    PUBLIC_BASE_URL: "http://localhost",
    RUN_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
    SECRETS_KEY: Buffer.alloc(32, 8).toString("base64"),
  },
  compatibilityDate: "2026-08-19",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"],
  durableObjects: {
    ARTIFACT_ROOM: { className: "ArtifactRoom", useSQLite: true },
    LIVE_ARTIFACT_MAINTENANCE: {
      className: "LiveArtifactMaintenance",
      useSQLite: true,
    },
  },
  modules: true,
  outboundService: (request) => {
    assert.equal(new URL(request.url).hostname, "public-images.example.com");
    externalImageRequests += 1;
    return new Response(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      { headers: { "Content-Type": "image/png" } }
    );
  },
  r2Buckets: ["FILES"],
  resourcePersistencePath: directory,
  script,
  workerLoaders: { LOADER: {} },
};
let runtime = new Miniflare(convertV4MiniflareOptions(options));
let passed = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
};
try {
  let db = await runtime.getD1Database("DB");
  const migrations = resolve(
    import.meta.dirname,
    "../../../../../../packages/db/migrations"
  );
  for (const name of (await readdir(migrations))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(join(migrations, name), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const now = new Date().toISOString(),
    lease = new Date(Date.now() + 3_600_000).toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspaces (id,clerk_org_id,name,timezone,created_at) VALUES ('w1','org_w1','Fixture','UTC',?)"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO agents (id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES ('a1','w1','u1',?,'','model','Fixture Agent','machine','{}','fixture','active')"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO sessions (id,workspace_id,agent_id,actor_id,actor_kind,created_at,origin) VALUES ('s1','w1','a1','u1','user',?,'ui')"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO runs (id,workspace_id,agent_id,session_id,actor_id,actor_kind,created_at,input_text,status,lease_until,on_behalf_of_user_id) VALUES ('r1','w1','a1','s1','u1','user',?,'','running',?,'u1')"
      )
      .bind(now, lease),
  ]);
  let response = await runtime.dispatchFetch("http://localhost/fixture/token", {
    method: "POST",
  });
  const { token } = await response.json();
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let rpcId = 0;
  const mcp = async (name, args, requestId) => {
    rpcId += 1;
    const r = await runtime.dispatchFetch("http://localhost/mcp", {
      body: JSON.stringify({
        id: requestId ?? rpcId,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers,
      method: "POST",
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`${r.status}: ${text}`);
    }
    const raw =
      text.startsWith("event:") || text.startsWith("data:")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .at(-1)
            .slice(5)
            .trim()
        : text;
    const result = JSON.parse(raw);
    if (result.error || result.result?.isError) {
      throw new Error(JSON.stringify(result));
    }
    return result.result.structuredContent;
  };
  const deckCreated = await mcp("artifact_create", {
    kind: "deck",
    slides: [
      '<slide id="s1" order="a0" background="#fff" transition="none" duration="0"><notes>Notes</notes><element id="e1" type="text" parent="s1" order="a0" prop-x="0" prop-y="0" prop-w="100" prop-h="50"><p>Deck content</p></element><element id="table" type="table" parent="s1" order="a1" prop-rows="2" prop-cols="2" prop-x="0" prop-y="100" prop-w="300" prop-h="200"></element></slide>',
    ],
    title: "Production deck",
  });
  check(Boolean(deckCreated.artifactId), "actual MCP deck creation");
  const cellResponse = await runtime.dispatchFetch(
    `http://localhost/fixture/ensure-cell/${deckCreated.artifactId}`,
    {
      body: JSON.stringify({ elementId: "table", key: "0:0", slideId: "s1" }),
      headers,
      method: "POST",
    }
  );
  const cellAllocated = await cellResponse.json();
  check(
    cellResponse.ok &&
      cellAllocated.revision > 0 &&
      cellAllocated.state.length > 0,
    "production service and room allocate sparse cell through authenticated adapter"
  );
  const deckRead = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  check(
    deckRead.slides[0].html.includes("Deck content"),
    "registered production deck_read loads real room"
  );
  let invalidDeckError = "";
  try {
    await mcp("deck_write", {
      artifactId: deckCreated.artifactId,
      ops: [
        {
          html: deckRead.slides[0].html.replace('prop-x="0"', 'prop-x="NaN"'),
          op: "write",
          revision: deckRead.slides[0].revision,
          slideId: "s1",
        },
      ],
    });
  } catch (error) {
    invalidDeckError = String(error);
  }
  check(
    invalidDeckError.includes("prop-x") &&
      invalidDeckError.includes("validation"),
    "actual RPC preserves deck validation code and exact core path"
  );
  const refreshedDeckRead = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  const deckInput = {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: deckRead.slides[0].html.replace(
          "Deck content",
          "Production edit"
        ),
        op: "write",
        revision: refreshedDeckRead.slides[0].revision,
        slideId: "s1",
      },
    ],
  };
  const deckEdit = await mcp("deck_write", deckInput);
  const deckRepeat = await mcp("deck_write", deckInput, rpcId);
  check(
    JSON.stringify(deckEdit) === JSON.stringify(deckRepeat),
    "MCP deck write idempotently replays durable result"
  );
  const deckFiles = await db
    .prepare(
      "SELECT f.path FROM artifact_version_files f JOIN artifacts a ON a.current_version_id=f.version_id WHERE a.id=?"
    )
    .bind(deckCreated.artifactId)
    .all();
  check(
    deckFiles.results.some((f) => f.path === "deck.json") &&
      deckFiles.results.some((f) => f.path === "state.ydoc"),
    "production deck checkpoint uses ordinary artifact version files"
  );
  // Actual MCP -> production room -> D1 ownership policy -> signed sandbox route.
  const embedPage = await mcp("artifact_create", {
    entry: "pages/chart.html",
    files: [
      {
        path: "pages/chart.html",
        text: "<!doctype html><html><body><h1>Controlled embed</h1></body></html>",
      },
    ],
    kind: "page",
    title: "Embed page",
  });
  await db
    .prepare("UPDATE artifacts SET audience='workspace' WHERE id=?")
    .bind(embedPage.artifactId)
    .run();
  const sources = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  const embedSource = sources.embedSources.find((source) =>
    source.includes(embedPage.artifactId)
  );
  check(
    Boolean(embedSource),
    "production deck_read exposes exact authorized source identity"
  );
  const embedHTML = `<element id="embedded" type="embed" parent="s1" order="a2" prop-src="${embedSource}" prop-x="350" prop-y="0" prop-w="400" prop-h="200"></element>`;
  await mcp("deck_write", {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: sources.slides[0].html.replace(
          "</slide>",
          `${embedHTML}</slide>`
        ),
        op: "write",
        revision: sources.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  check(
    (
      await mcp("deck_read", { artifactId: deckCreated.artifactId })
    ).slides[0].html.includes('type="embed"'),
    "actual production room accepts guarded embed HTML"
  );
  // Catalog growth must not revoke an already admitted exact file identity.
  await db
    .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2001)
    INSERT INTO artifact_version_files (workspace_id,version_id,path,sha256,size,content_type)
    SELECT workspace_id,version_id,'000-' || printf('%04d',n.x) || '.html',sha256,size,content_type
    FROM artifact_version_files,n WHERE version_id=(SELECT current_version_id FROM artifacts WHERE id=?) AND path='pages/chart.html'`)
    .bind(embedPage.artifactId)
    .run();
  // A non-embeddable HTML-like filename must not end discovery prematurely.
  await db
    .prepare(`INSERT INTO artifact_version_files (workspace_id,version_id,path,sha256,size,content_type)
    SELECT workspace_id,version_id,'!ineligible.HTML',sha256,size,content_type FROM artifact_version_files
    WHERE version_id=(SELECT current_version_id FROM artifacts WHERE id=?) AND path='pages/chart.html'`)
    .bind(embedPage.artifactId)
    .run();
  const discovered = new Set();
  let cursor;
  do {
    const pageResponse = await runtime.dispatchFetch(
      `http://localhost/fixture/embed-sources/${deckCreated.artifactId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    check(pageResponse.ok, "paginated discovery succeeds in workerd");
    const page = await pageResponse.json();
    for (const source of page.sources) {
      check(!discovered.has(source), "keyset discovery has no duplicates");
      discovered.add(source);
    }
    cursor = page.next;
  } while (cursor);
  check(
    discovered.size === 2002 && discovered.has(embedSource),
    "discovery reaches every source beyond 2000"
  );
  const grownCatalog = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  check(
    grownCatalog.embedSources.includes(embedSource),
    "source remains admitted beyond 2000 eligible files"
  );
  const resolved = await runtime.dispatchFetch(
    `http://localhost/fixture/embed/${deckCreated.artifactId}`,
    { body: JSON.stringify({ source: embedSource }), method: "POST" }
  );
  check(resolved.ok, "member resolver authorizes deck and source");
  const openedEmbed = await resolved.json();
  const servedEmbed = await runtime.dispatchFetch(
    `http://localhost${openedEmbed.contentUrl}`
  );
  check(
    servedEmbed.ok && (await servedEmbed.text()).includes("Controlled embed"),
    "existing sandbox route serves exact artifact-owned HTML"
  );
  check(
    servedEmbed.headers
      .get("Content-Security-Policy")
      .includes("sandbox allow-scripts allow-forms"),
    "embed keeps production CSP sandbox"
  );
  await db
    .prepare(
      "DELETE FROM artifact_version_files WHERE version_id=(SELECT current_version_id FROM artifacts WHERE id=?) AND path LIKE '000-%'"
    )
    .bind(embedPage.artifactId)
    .run();
  for (const bad of [
    "https://evil.test",
    embedSource.replace(/:[a-f0-9]{64}:/, `:${"f".repeat(64)}:`),
  ]) {
    const read = await mcp("deck_read", { artifactId: deckCreated.artifactId });
    let refused = false;
    try {
      await mcp("deck_write", {
        artifactId: deckCreated.artifactId,
        ops: [
          {
            html: read.slides[0].html.replace(embedSource, bad),
            op: "write",
            revision: read.slides[0].revision,
            slideId: "s1",
          },
        ],
      });
    } catch {
      refused = true;
    }
    check(
      refused,
      "production room refuses unsupported or wrong-identity source"
    );
  }
  await db
    .prepare("UPDATE artifacts SET audience='private' WHERE id=?")
    .bind(embedPage.artifactId)
    .run();
  const revokedEmbed = await runtime.dispatchFetch(
    `http://localhost/fixture/embed/${deckCreated.artifactId}`,
    { body: JSON.stringify({ source: embedSource }), method: "POST" }
  );
  check(!revokedEmbed.ok, "private source cannot mint embed content URL");
  const retainedPolicy = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/policy/${deckCreated.artifactId}`,
      { headers }
    )
  ).json();
  check(
    retainedPolicy.urls.includes(embedSource),
    "member policy retains admitted unavailable reference for reload and editing"
  );
  const restrictedRead = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  await mcp("deck_write", {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: restrictedRead.slides[0].html.replace(
          'prop-x="350"',
          'prop-x="351"'
        ),
        op: "write",
        revision: restrictedRead.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  const removable = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  await mcp("deck_write", {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: removable.slides[0].html.replace(
          /<element\b[^>]*id="embedded"[^>]*>[\s\S]*?<\/element>/,
          ""
        ),
        op: "write",
        revision: removable.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  check(
    !(
      await mcp("deck_read", { artifactId: deckCreated.artifactId })
    ).slides[0].html.includes('id="embedded"'),
    "restricted source can be edited and removed without restoring source access"
  );
  await db
    .prepare("UPDATE artifacts SET audience='workspace' WHERE id=?")
    .bind(embedPage.artifactId)
    .run();
  await db
    .prepare(
      "INSERT INTO workspaces (id,clerk_org_id,name,timezone,created_at) VALUES ('w2','org_w2','Other workspace','UTC',?)"
    )
    .bind(now)
    .run();
  await db
    .prepare(
      "UPDATE artifact_version_files SET workspace_id='w2' WHERE version_id=(SELECT current_version_id FROM artifacts WHERE id=?)"
    )
    .bind(embedPage.artifactId)
    .run();
  const wrongScopeEmbed = await runtime.dispatchFetch(
    `http://localhost/fixture/embed/${deckCreated.artifactId}`,
    { body: JSON.stringify({ source: embedSource }), method: "POST" }
  );
  check(
    !wrongScopeEmbed.ok,
    "exact file workspace must match both artifact and published version"
  );
  await db
    .prepare(
      "UPDATE artifact_version_files SET workspace_id='w1' WHERE version_id=(SELECT current_version_id FROM artifacts WHERE id=?)"
    )
    .bind(embedPage.artifactId)
    .run();
  const readd = await mcp("deck_read", { artifactId: deckCreated.artifactId });
  await mcp("deck_write", {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: readd.slides[0].html.replace("</slide>", `${embedHTML}</slide>`),
        op: "write",
        revision: readd.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  await db
    .prepare("UPDATE artifacts SET deleted_at=? WHERE id=?")
    .bind(now, embedPage.artifactId)
    .run();
  const deletedRead = await mcp("deck_read", {
    artifactId: deckCreated.artifactId,
  });
  await mcp("deck_write", {
    artifactId: deckCreated.artifactId,
    ops: [
      {
        html: deletedRead.slides[0].html.replace(
          /<element\b[^>]*id="embedded"[^>]*>[\s\S]*?<\/element>/,
          ""
        ),
        op: "write",
        revision: deletedRead.slides[0].revision,
        slideId: "s1",
      },
    ],
  });
  check(
    !(
      await mcp("deck_read", { artifactId: deckCreated.artifactId })
    ).slides[0].html.includes('id="embedded"'),
    "deleted source can be removed and checkpointed"
  );
  const deckJoin = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/join/${deckCreated.artifactId}`,
      { headers, method: "POST" }
    )
  ).json();
  check(
    deckJoin.role === "editor" && deckJoin.ticket,
    "deck shares production admission"
  );
  const emptyDeck = await mcp("artifact_create", {
    kind: "deck",
    title: "Empty deck",
  });
  const emptyRead = await mcp("deck_read", {
    artifactId: emptyDeck.artifactId,
  });
  check(
    emptyRead.slides.length === 0,
    "empty deck opens with actual initialized authority"
  );
  await db
    .prepare(
      "UPDATE artifacts SET owner_user_id='other',audience='private' WHERE id=?"
    )
    .bind(emptyDeck.artifactId)
    .run();
  await db
    .prepare(
      "INSERT INTO artifact_members (id,workspace_id,artifact_id,principal_kind,user_id,role,created_by,created_at) VALUES ('source-viewer','w1',?,'user','u1','viewer','other',?)"
    )
    .bind(emptyDeck.artifactId, now)
    .run();
  await db
    .prepare(
      "UPDATE sessions SET origin='artifact',external_key=? WHERE id='s1'"
    )
    .bind(emptyDeck.artifactId)
    .run();
  let sourceDenied = false;
  try {
    await mcp("deck_write", {
      artifactId: deckCreated.artifactId,
      ops: [
        {
          html: '<slide id="forbidden" order="a1" background="#fff" transition="none" duration="0"></slide>',
          op: "add",
        },
      ],
    });
  } catch {
    sourceDenied = true;
  }
  check(
    sourceDenied,
    "artifact-triggered deck writer is capped by source viewer role"
  );
  await db
    .prepare(
      "UPDATE artifact_members SET role='editor' WHERE id='source-viewer'"
    )
    .run();
  await db
    .prepare(
      "UPDATE artifacts SET owner_user_id='other',audience='private' WHERE id=?"
    )
    .bind(deckCreated.artifactId)
    .run();
  await db
    .prepare(
      "INSERT INTO artifact_members (id,workspace_id,artifact_id,principal_kind,user_id,role,created_by,created_at) VALUES ('target-viewer','w1',?,'user','u1','viewer','other',?)"
    )
    .bind(deckCreated.artifactId, now)
    .run();
  let targetDenied = false;
  try {
    await mcp("deck_write", {
      artifactId: deckCreated.artifactId,
      ops: [
        {
          html: '<slide id="forbidden" order="a1" background="#fff" transition="none" duration="0"></slide>',
          op: "add",
        },
      ],
    });
  } catch {
    targetDenied = true;
  }
  check(
    targetDenied,
    "artifact-triggered deck writer is independently capped by target viewer role"
  );
  await db
    .prepare("UPDATE sessions SET origin='ui',external_key=NULL WHERE id='s1'")
    .run();
  const created = await mcp("artifact_create", {
    kind: "document",
    markdown: "# Fixture\n\nHello human words here.",
    title: "Production fixture",
  });
  check(Boolean(created.artifactId), "run token artifact_create");
  const read = await mcp("document_read", { artifactId: created.artifactId });
  check(
    read.blocks.some((b) => b.text === "Hello human words here."),
    "real room loaded R2 checkpoint"
  );
  const target = read.blocks.find((b) => b.text === "Hello human words here.");
  const editInput = {
    artifactId: created.artifactId,
    ops: [
      {
        content: { text: "Agent edited actual room." },
        op: "replace",
        target: { blockId: target.id, ifHash: target.hash, ifRev: target.rev },
      },
    ],
    summary: "Fixture edit",
  };
  const edit = await mcp("document_edit", editInput);
  const editRequestId = rpcId;
  const repeat = await mcp("document_edit", editInput, editRequestId);
  check(
    repeat.changeId === edit.changeId && repeat.revision === edit.revision,
    "same tool call replays the durable room result"
  );

  check(edit.revision > read.revision, "MCP edit advanced room");
  const persisted = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    persisted.markdown.includes("Agent edited actual room."),
    "R2/DB checkpoint roundtrip"
  );
  const importedResponse = await runtime.dispatchFetch(
    `http://localhost/fixture/import-image/${created.artifactId}`,
    {
      body: JSON.stringify({ url: "https://public-images.example.com/photo" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
  check(
    importedResponse.ok,
    `external image import stores in actual R2/workerd: ${await importedResponse.clone().text()}`
  );
  const importedImage = await importedResponse.json();
  check(
    importedImage.url.startsWith("/files/") && externalImageRequests === 1,
    "external image returns only own blob canonical URL"
  );
  const importedPolicy = await (
    await runtime.dispatchFetch(
      `http://localhost/api/live-artifacts/${created.artifactId}/policy`,
      { headers }
    )
  ).json();
  check(
    importedPolicy.ownBlobUrls.includes(importedImage.url),
    "import acknowledgement follows production room ownership registration"
  );
  const image = new FormData();
  image.set(
    "file",
    new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], {
      type: "image/png",
    }),
    "own.png"
  );
  const uploadRequest = new Request(
    `http://localhost/api/live-artifacts/${created.artifactId}/images`,
    {
      body: image,
      headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost" },
      method: "POST",
    }
  );
  const upload = await runtime.dispatchFetch(uploadRequest.url, {
    body: await uploadRequest.arrayBuffer(),
    headers: uploadRequest.headers,
    method: "POST",
  });
  check(
    upload.status === 201,
    `authorized raster upload persisted: ${upload.status} ${await upload.clone().text()}`
  );
  const uploaded = await upload.json();
  const policy = await (
    await runtime.dispatchFetch(
      `http://localhost/api/live-artifacts/${created.artifactId}/policy`,
      { headers }
    )
  ).json();
  check(
    policy.ownBlobUrls.includes(uploaded.url),
    "own blob policy durable before upload response"
  );
  check(
    policy.agentChanges.some(
      (change) => change.name === "Fixture Agent" && change.text.length > 0
    ),
    "authoritative persisted origin ranges exposed"
  );
  const stranger = await mcp("artifact_create", {
    kind: "document",
    title: "Other document",
  });
  const otherPolicy = await (
    await runtime.dispatchFetch(
      `http://localhost/api/live-artifacts/${stranger.artifactId}/policy`,
      { headers }
    )
  ).json();
  check(
    !otherPolicy.ownBlobUrls.includes(uploaded.url),
    "image ownership is exact artifact scope"
  );
  const markdown = await (
    await runtime.dispatchFetch(
      `http://localhost/api/live-artifacts/${created.artifactId}/markdown`,
      { headers }
    )
  ).json();
  check(
    markdown.filename.endsWith(".md") &&
      markdown.markdown === persisted.markdown,
    "persisted browser markdown contract"
  );
  const versions = await db
    .prepare("SELECT count(*) as n FROM artifact_versions WHERE artifact_id=?")
    .bind(created.artifactId)
    .first();
  check(versions.n === 2, "one durable edit checkpoint");
  const changes = await db
    .prepare("SELECT * FROM artifact_live_changes WHERE artifact_id=?")
    .bind(created.artifactId)
    .all();
  check(
    changes.results.length === 1 && changes.results[0].id === edit.changeId,
    "durable room change reconciled"
  );
  const checkpoint = await runtime.dispatchFetch(
    `http://localhost/fixture/checkpoint/${created.artifactId}`,
    { headers, method: "POST" }
  );
  check(checkpoint.ok, "clean checkpoint acknowledgement is idempotent");
  await db.exec(
    "CREATE TRIGGER fixture_fail_checkpoint BEFORE INSERT ON artifact_versions WHEN NEW.artifact_id='" +
      created.artifactId +
      "' AND NEW.number=3 BEGIN SELECT RAISE(ABORT,'fixture checkpoint DB failure'); END;"
  );
  let failed = false;
  try {
    await mcp("document_edit", {
      artifactId: created.artifactId,
      ops: [
        {
          content: {
            markdown: `Crash retry survives.\n\n![own](${uploaded.url})`,
          },
          op: "insert",
        },
      ],
      summary: "Crash retry",
    });
  } catch {
    failed = true;
  }
  check(
    failed,
    "actual DB failure after room mutation and R2 writes is surfaced"
  );
  const old = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    old.markdown === persisted.markdown,
    "failed publication leaves current DB pointer unchanged"
  );
  const expired = await runtime.dispatchFetch(
    `http://localhost/fixture/expire-credentials/${created.artifactId}`,
    { method: "POST" }
  );
  check(
    (await expired.json()) > 0,
    "outage outlives every persisted actor credential"
  );
  await db.exec("DROP TRIGGER fixture_fail_checkpoint;");
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  // Observe D1 only: no authenticated room request can refresh credentials.
  const recoveryDeadline = Date.now() + 12_000;
  let checkpointRecovered = false;
  while (Date.now() < recoveryDeadline) {
    const row = await db
      .prepare(
        "SELECT count(*) as n FROM artifact_versions WHERE artifact_id=?"
      )
      .bind(created.artifactId)
      .first();
    if (row.n === 3) {
      checkpointRecovered = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  check(
    checkpointRecovered,
    "alarm publishes frozen checkpoint after restart and credential expiry without a new actor request"
  );
  const repaired = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    repaired.markdown.includes("Crash retry survives."),
    "retry commits frozen room state to R2 and DB"
  );
  persisted.markdown = repaired.markdown;
  const repairedVersions = await db
    .prepare("SELECT count(*) as n FROM artifact_versions WHERE artifact_id=?")
    .bind(created.artifactId)
    .first();
  check(
    repairedVersions.n === 3,
    "crash retry creates exactly one checkpoint version"
  );
  const bucket = await runtime.getR2Bucket("FILES");
  const publishedFiles = await db
    .prepare(
      "SELECT f.path,f.sha256 FROM artifact_version_files f JOIN artifacts a ON a.current_version_id=f.version_id WHERE a.id=?"
    )
    .bind(created.artifactId)
    .all();
  const imageFile = publishedFiles.results.find((file) =>
    file.path.startsWith("images/")
  );
  check(
    Boolean(imageFile),
    "checkpoint publishes owned images with static artifact files"
  );
  const htmlFile = publishedFiles.results.find(
    (file) => file.path === "index.html"
  );
  const html = await (
    await bucket.get(`w1/artifact-blobs/${htmlFile.sha256}`)
  ).text();
  check(
    html.includes(`src="${imageFile.path}"`) && !html.includes('src="/files/'),
    "checkpoint HTML uses version-owned images for read-only link viewers"
  );
  const delta = await mcp("document_read", {
    artifactId: created.artifactId,
    sinceRev: read.revision,
  });
  check(
    delta.blocks.length > 0 &&
      delta.blocks.some((block) =>
        block.text.includes("Crash retry survives.")
      ),
    "chunked outline history survives room restart"
  );
  response = await runtime.dispatchFetch(
    `http://localhost/fixture/join/${created.artifactId}`,
    { headers, method: "POST" }
  );
  const admission = await response.json();
  const socketUrl = `http://localhost${admission.roomUrl}?ticket=${encodeURIComponent(admission.ticket)}`;
  const denied = await runtime.dispatchFetch(socketUrl, {
    headers: { Upgrade: "websocket" },
  });
  check(denied.status === 401, "ticket without real credential denied");
  const tcpUrl = new URL(
    `${admission.roomUrl}?ticket=${encodeURIComponent(admission.ticket)}`,
    await runtime.ready
  );
  tcpUrl.protocol = "ws:";
  const socket = new WebSocket(tcpUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let closeDetail;
  const closed = new Promise((resolveClose) =>
    socket.addEventListener(
      "close",
      (event) => {
        closeDetail = {
          at: Date.now(),
          code: event.code,
          reason: event.reason,
        };
        resolveClose(true);
      },
      { once: true }
    )
  );
  const status = await new Promise((resolveStatus) => {
    socket.addEventListener("open", () => resolveStatus(101), { once: true });
    socket.addEventListener("error", () => resolveStatus(403), { once: true });
  });
  check(status === 101, "authenticated initial TCP request accepted");
  const replay = await runtime.dispatchFetch(socketUrl, {
    headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
  });
  check(replay.status === 403, "room replay consumed durably");
  const beforeDelete = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/diagnostics/${created.artifactId}`
    )
  ).text();
  await db.batch([
    db
      .prepare("UPDATE artifacts SET deleted_at=? WHERE id=?")
      .bind(new Date().toISOString(), created.artifactId),
    db
      .prepare(
        "INSERT INTO artifact_room_invalidations (id,workspace_id,artifact_id,created_at) VALUES ('invalidation-crash','w1',?,?)"
      )
      .bind(created.artifactId, new Date().toISOString()),
  ]);
  const didClose = await Promise.race([
    closed,
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 4500)
    ),
  ]);
  const diagnostic = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/diagnostics/${created.artifactId}`
    )
  ).text();
  check(
    didClose ||
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED,
    `durable refresh closes revoked socket within five seconds without request waitUntil: ${diagnostic}, before ${beforeDelete}, state ${socket.readyState}, close ${JSON.stringify(closeDetail)}`
  );
  await new Promise((resolveAlarm) => setTimeout(resolveAlarm, 2500));
  const outbox = await db
    .prepare(
      "SELECT completed_at FROM artifact_room_invalidations WHERE id='invalidation-crash'"
    )
    .first();
  check(
    Boolean(outbox.completed_at),
    "durable maintenance alarm acknowledges committed invalidation outbox"
  );
  await db
    .prepare("UPDATE artifacts SET deleted_at=NULL WHERE id=?")
    .bind(created.artifactId)
    .run();
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const recovered = await (
    await runtime.dispatchFetch(
      `http://localhost/fixture/persisted/${created.artifactId}`,
      { headers }
    )
  ).json();
  check(
    recovered.markdown === persisted.markdown,
    "R2 D1 persistence across runtime restart"
  );
  const large = await (
    await runtime.dispatchFetch("http://localhost/fixture/large", {
      headers,
      method: "POST",
    })
  ).json();
  check(
    large.chars === 5_000_000,
    "actual service R2/DB to room five-million-character document"
  );
  check(
    large.limits.largest < 512 * 1024,
    "large wrapper history uses chunks rather than oversized metadata rows"
  );
  console.log(JSON.stringify({ passed }));
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
