// biome-ignore-all lint/performance/noNamespaceImport: Yjs/lib0 protocol namespaces in standalone fixture.
// biome-ignore-all lint/style/useDestructuring: sequential integration assertions retain named intermediate values.
// biome-ignore-all lint/performance/useTopLevelRegex: fixture-only credential extraction.
// biome-ignore-all lint/suspicious/noShadow: isolated callback arguments in the ordered fixture.
// biome-ignore-all lint/performance/noAwaitInLoops: ordered integration scenario and migrations.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd integration runner.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as Y from "yjs";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const directory = await mkdtemp(join(tmpdir(), "live-production-"));
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
    SESSION_STREAM: { className: "SessionStream" },
  },
  modules: true,
  outboundService: () =>
    new Response("External providers disabled in local fixture", {
      status: 503,
    }),
  r2Buckets: ["FILES"],
  resourcePersistencePath: directory,
  script,
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
    _lease = new Date(Date.now() + 3_600_000).toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces (id,clerk_org_id,name,timezone,created_at) VALUES ('w1','org_w1','Guest fixture','UTC',?)"
    )
    .bind(now)
    .run();
  const request = (path, init = {}) =>
    runtime.dispatchFetch(`http://localhost${path}`, init);
  const post = async (path, body, cookie) => {
    const response = await request(path, {
      body: JSON.stringify(body),
      headers: {
        "CF-Connecting-IP": "192.0.2.1",
        "Content-Type": "application/json",
        Origin: "http://localhost",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      method: "POST",
    });
    return response;
  };
  const create = async (email, role, artifactId, kind) => {
    const response = await post("/fixture/create", {
      artifactId,
      email,
      kind,
      role,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const text = result.mail.at(-1).text;
    return { ...result, token: text.match(/hm_invite_[A-Za-z0-9_-]+/)[0] };
  };
  const signIn = async (invite) => {
    const landing = await request(`/g/${invite.token}`);
    check(landing.ok, "scanner-safe landing is mounted");
    const before = await db
      .prepare("SELECT count(*) n FROM guest_codes")
      .first();
    await request(`/g/${invite.token}`);
    check(
      (await db.prepare("SELECT count(*) n FROM guest_codes").first()).n ===
        before.n,
      "GET sends no code"
    );
    assert.equal(
      (await post(`/api/guest/${invite.token}/code`, {})).status,
      200
    );
    const mail = await (await request("/fixture/mail")).json();
    const code = mail.at(-1).text.match(/\n(\d{6})\n/)[1];
    const verified = await post(`/api/guest/${invite.token}/verify`, { code });
    assert.equal(verified.status, 200, await verified.clone().text());
    const set = verified.headers.get("Set-Cookie");
    check(
      set.includes("Secure") &&
        set.includes("HttpOnly") &&
        set.startsWith("__Host-hm_guest="),
      "secure host guest cookie"
    );
    return set.split(";")[0];
  };
  const editor = await create("editor@example.com", "editor");
  const viewer = await create(
    "viewer@example.com",
    "viewer",
    editor.artifactId
  );
  let editorCookie = await signIn(editor),
    viewerCookie = await signIn(viewer);
  const guest = (id, action) => `/api/guest/artifacts/${id}/${action}`;
  const read = await request(guest(editor.artifactId, "open"), {
    headers: { Cookie: editorCookie },
  });
  assert.equal(read.status, 200, await read.clone().text());
  editorCookie = read.headers.get("Set-Cookie").split(";")[0];
  const snapshot = await read.json();
  check(
    snapshot.grant.role === "editor" && snapshot.state.length > 0,
    "actual R2 room read via guest endpoint"
  );
  check(
    (
      await db
        .prepare("SELECT count(*) n FROM artifact_views WHERE surface='guest'")
        .first()
    ).n === 1,
    "one guest open logged"
  );
  const forbidden = await post(
    guest(editor.artifactId, "comment"),
    { body: "Viewer cannot comment" },
    viewerCookie
  );
  check(forbidden.status === 404, "viewer cannot comment");
  viewerCookie =
    forbidden.headers.get("Set-Cookie")?.split(";")[0] ?? viewerCookie;
  const csrf = await request(guest(editor.artifactId, "comment"), {
    body: '{"body":"No"}',
    headers: {
      "Content-Type": "application/json",
      Cookie: editorCookie,
      Origin: "https://evil.example",
    },
    method: "POST",
  });
  check(csrf.status === 403, "cross origin mutation refused");
  check(
    (
      await request(guest(crypto.randomUUID(), "open"), {
        headers: { Cookie: editorCookie },
      })
    ).status === 404,
    "cross artifact denied"
  );
  const comment = await post(
    guest(editor.artifactId, "comment"),
    { body: "Actual guest comment" },
    editorCookie
  );
  assert.equal(comment.status, 200, await comment.clone().text());
  editorCookie = comment.headers.get("Set-Cookie").split(";")[0];
  check(
    (await db.prepare("SELECT author_kind FROM artifact_comments").first())
      .author_kind === "guest",
    "comment attributed truthfully"
  );
  check(
    (
      await request(`/api/live-artifacts/${editor.artifactId}/policy`, {
        headers: { Cookie: editorCookie },
      })
    ).status === 401,
    "member image policy ignores guest cookie"
  );
  const disabledAsk = await post(
    guest(editor.artifactId, "ask"),
    { requestId: "disabled-guest-ask", text: "No guest agent" },
    editorCookie
  );
  check(
    disabledAsk.status === 404,
    "guest execution remains disabled without restricted adapter"
  );
  const nextAskCookie = disabledAsk.headers.get("Set-Cookie")?.split(";")[0];
  check(
    nextAskCookie && nextAskCookie !== editorCookie,
    "failed ask rotates cookie"
  );
  editorCookie = nextAskCookie;
  check(
    (
      await db
        .prepare("SELECT count(*) n FROM runs WHERE actor_kind='guest'")
        .first()
    ).n === 0,
    "disabled guest ask inserts no run and charges no cap"
  );
  const image = new FormData();
  image.set(
    "file",
    new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], {
      type: "image/png",
    }),
    "guest.png"
  );
  const imageRequest = new Request(
    `http://localhost${guest(editor.artifactId, "images")}`,
    {
      body: image,
      headers: { Cookie: editorCookie, Origin: "http://localhost" },
      method: "POST",
    }
  );
  const uploaded = await request(guest(editor.artifactId, "images"), {
    body: await imageRequest.arrayBuffer(),
    headers: imageRequest.headers,
    method: "POST",
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  editorCookie = uploaded.headers.get("Set-Cookie").split(";")[0];
  const imageResult = await uploaded.json();
  const downloaded = await request(imageResult.guestUrl, {
    headers: { Cookie: viewerCookie },
  });
  check(
    downloaded.ok &&
      downloaded.headers.get("Content-Security-Policy").includes("sandbox"),
    "same-artifact guest image download is sandboxed"
  );
  viewerCookie = downloaded.headers.get("Set-Cookie").split(";")[0];
  check(
    (
      await request(
        imageResult.guestUrl.replace(editor.artifactId, crypto.randomUUID()),
        { headers: { Cookie: viewerCookie } }
      )
    ).status === 404,
    "cross-artifact guest image refused"
  );
  const deck = await create("editor@example.com", "editor", undefined, "deck");
  const allocated = await post(
    guest(deck.artifactId, "ensure-deck-cell"),
    { elementId: "table", key: "0:0", slideId: "s1" },
    editorCookie
  );
  assert.equal(allocated.status, 200, await allocated.clone().text());
  editorCookie = allocated.headers.get("Set-Cookie").split(";")[0];
  const cell = await allocated.json();
  check(
    cell.state.length > 0 && cell.revision > 0,
    "guest editor uses actual production sparse cell authority"
  );
  const resolveEmbed = async (source, artifactId = deck.artifactId) => {
    const response = await post(
      guest(artifactId, "embed"),
      { source },
      editorCookie
    );
    editorCookie =
      response.headers.get("Set-Cookie")?.split(";")[0] ?? editorCookie;
    return response;
  };
  const guestEmbed = await resolveEmbed(deck.embedSource);
  assert.equal(guestEmbed.status, 200, await guestEmbed.clone().text());
  const embedded = await guestEmbed.json();
  const embeddedContent = await request(embedded.contentUrl, {
    headers: { "Sec-Fetch-Dest": "iframe" },
  });
  check(
    embeddedContent.ok &&
      (await embeddedContent.text()).includes("Guest scoped embed"),
    "guest exact retained embed renders through actual sandbox content route"
  );
  const embedPolicy = await request(guest(deck.artifactId, "policy"), {
    headers: { Cookie: editorCookie },
  });
  editorCookie = embedPolicy.headers.get("Set-Cookie").split(";")[0];
  check(
    (await embedPolicy.json()).ownBlobUrls.includes(deck.embedSource),
    "guest policy retains deck embed identity without treating it as an image"
  );
  check(
    (await resolveEmbed(deck.embedSource.replace("chart.html", "other.html")))
      .status === 404,
    "guest cannot select another source path"
  );
  check(
    (
      await resolveEmbed(
        deck.embedSource.replace(/:[a-f0-9]{64}:/, `:${"b".repeat(64)}:`)
      )
    ).status === 404,
    "guest cannot select another source hash"
  );
  check(
    (await resolveEmbed(deck.embedSource, editor.artifactId)).status === 404,
    "grant on another artifact cannot read deck source"
  );
  const sourceId = deck.embedSource.split(":")[1];
  await db
    .prepare("UPDATE artifacts SET audience='private' WHERE id=?")
    .bind(sourceId)
    .run();
  check(
    (await request(embedded.contentUrl)).status === 403,
    "issued guest content URL checks current source eligibility"
  );
  await db
    .prepare("UPDATE artifacts SET audience='workspace' WHERE id=?")
    .bind(sourceId)
    .run();
  check(
    (await request(embedded.contentUrl)).ok,
    "session reference survives normal HTTP credential rotation"
  );
  await post(`/fixture/revoke/${deck.artifactId}/${deck.memberId}`, {});
  check(
    (await request(embedded.contentUrl)).status === 403,
    "issued guest embed capability is revoked with exact invited deck grant"
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO agents (id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES ('thread-agent','w1','u1',?,'','model','Agent','machine','{}','thread-agent','active')"
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO sessions (id,workspace_id,agent_id,actor_id,actor_kind,created_at,origin,external_key) VALUES ('guest-artifact-thread','w1','thread-agent','u1','user',?,'artifact',?)"
      )
      .bind(now, editor.artifactId),
    db
      .prepare(
        "INSERT INTO events (id,workspace_id,actor_id,actor_kind,session_id,type,payload,created_at) VALUES ('guest-thread-event','w1','u1','user','guest-artifact-thread','message.user',?,?)"
      )
      .bind(JSON.stringify({ text: "Exact artifact thread" }), now),
  ]);

  const review = await create("review-editor@example.com", "editor");
  const reviewViewer = await create(
    "review-viewer@example.com",
    "viewer",
    review.artifactId
  );
  let reviewCookie = await signIn(review);
  let reviewViewerCookie = await signIn(reviewViewer);
  await db
    .prepare(
      "INSERT INTO runs (id,workspace_id,agent_id,actor_id,actor_kind,created_at,input_text,session_id,status,on_behalf_of_user_id,scope_artifact_id,lease_until) VALUES ('suggestion-run','w1','thread-agent','u1','user',?,'fixture','guest-artifact-thread','running','u1',?,?)"
    )
    .bind(now, review.artifactId, _lease)
    .run();
  const proposed = await post(`/fixture/suggestion/${review.artifactId}`, {});
  assert.equal(proposed.status, 200, await proposed.clone().text());
  check(
    (await proposed.json()).suggestionId === "guest-review",
    "production document MCP path stages suggestion"
  );
  const listed = await request(guest(review.artifactId, "suggestions"), {
    headers: { Cookie: reviewCookie },
  });
  assert.equal(listed.status, 200, await listed.clone().text());
  reviewCookie = listed.headers.get("Set-Cookie").split(";")[0];
  check(
    (await listed.json()).items[0].status === "pending",
    "real guest endpoint lists durable pending preview"
  );
  const viewerDecision = await post(
    guest(review.artifactId, "decide-suggestion"),
    { decision: "accept", suggestionId: "guest-review" },
    reviewViewerCookie
  );
  check(
    viewerDecision.status !== 200,
    "current viewer cannot accept suggestion"
  );
  reviewViewerCookie =
    viewerDecision.headers.get("Set-Cookie")?.split(";")[0] ??
    reviewViewerCookie;
  const acceptedReview = await post(
    guest(review.artifactId, "decide-suggestion"),
    { decision: "accept", suggestionId: "guest-review" },
    reviewCookie
  );
  assert.equal(acceptedReview.status, 200, await acceptedReview.clone().text());
  reviewCookie = acceptedReview.headers.get("Set-Cookie").split(";")[0];
  const acceptedRecord = (await acceptedReview.json()).items[0];
  check(
    acceptedRecord.status === "accepted" &&
      acceptedRecord.decidedBy.startsWith("g:"),
    "real current guest editor accepts with guest attribution"
  );
  const transcript = await request(guest(editor.artifactId, "session"), {
    headers: { Cookie: editorCookie },
  });
  editorCookie = transcript.headers.get("Set-Cookie").split(";")[0];
  check(
    (await transcript.json()).events[0].payload.text ===
      "Exact artifact thread",
    "mounted replay reads the artifact's exact session"
  );
  const stream = await request(
    `${guest(editor.artifactId, "session")}/stream?after=0000`,
    { headers: { Cookie: editorCookie } }
  );
  assert.equal(
    stream.status,
    200,
    stream.status === 200 ? "" : await stream.text()
  );
  editorCookie = stream.headers.get("Set-Cookie").split(";")[0];
  const streamReader = stream.body.getReader();
  check(
    new TextDecoder()
      .decode((await streamReader.read()).value)
      .includes("Exact artifact thread"),
    "mounted guest SSE replays through SessionStream with no fake member"
  );
  const joinRoom = async (cookie) => {
    const joined = await post(guest(editor.artifactId, "join"), {}, cookie);
    assert.equal(joined.status, 200, await joined.clone().text());
    const next = joined.headers.get("Set-Cookie").split(";")[0];
    const result = await joined.json();
    const url = new URL(
      `${result.roomUrl}?ticket=${encodeURIComponent(result.ticket)}`,
      await runtime.ready
    );
    const origin = url.origin;
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { Cookie: next, Origin: origin },
    });
    socket.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return { cookie: next, socket };
  };
  const first = await joinRoom(editorCookie),
    second = await joinRoom(viewerCookie);
  editorCookie = first.cookie;
  viewerCookie = second.cookie;
  check(
    Boolean(first.socket && second.socket),
    "two real guest room clients admitted"
  );
  const replica = new Y.Doc();
  replica.getXmlFragment("content");
  Y.applyUpdate(replica, Uint8Array.from(snapshot.state));
  const vector = Y.encodeStateVector(replica);
  const paragraph = replica.getXmlFragment("content").toArray()[1];
  paragraph.toArray()[0].insert(0, "Guest edited ");
  const frame = encoding.createEncoder();
  encoding.writeVarUint(frame, 0);
  encoding.writeVarUint(frame, 2);
  encoding.writeVarUint8Array(frame, Y.encodeStateAsUpdate(replica, vector));
  const observed = new Promise((resolve) =>
    second.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        return;
      }
      const decoder = decoding.createDecoder(new Uint8Array(event.data));
      if (
        decoding.readVarUint(decoder) === 0 &&
        decoding.readVarUint(decoder) === 2
      ) {
        resolve();
      }
    })
  );
  first.socket.send(encoding.toUint8Array(frame));
  await Promise.race([
    observed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("guest update was not replicated")),
        4000
      )
    ),
  ]);
  check(true, "guest edit replicated to second real client");
  const later = await create("later@example.com", "editor", editor.artifactId);
  const laterCookie = await signIn(later);
  const laterSocket = await joinRoom(laterCookie);
  const downgraded = await post(
    `/fixture/role/${editor.artifactId}/${later.memberId}`,
    {}
  );
  check(downgraded.ok, "member role API applies to live guest room");
  const roleRead = await request(guest(editor.artifactId, "open"), {
    headers: { Cookie: laterSocket.cookie },
  });
  check(
    (await roleRead.json()).grant.role === "viewer",
    "next request sees downgraded role"
  );
  const laterCurrentCookie = roleRead.headers.get("Set-Cookie").split(";")[0];
  await db.exec(
    `CREATE TRIGGER fixture_fail_guest BEFORE INSERT ON artifact_versions WHEN NEW.artifact_id='${editor.artifactId}' AND NEW.number=2 BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END;`
  );
  check(
    (await post(`/fixture/checkpoint/${editor.artifactId}`, {})).status === 500,
    "checkpoint failure retains frozen pending receipt"
  );
  const closed = new Promise((resolve) =>
    first.socket.addEventListener("close", resolve, { once: true })
  );
  const revoked = await post(
    `/fixture/revoke/${editor.artifactId}/${editor.memberId}`,
    {}
  );
  assert.equal(revoked.status, 200, await revoked.text());
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 4500)),
  ]);
  check(
    first.socket.readyState >= 2,
    "revoke closes socket within five seconds"
  );
  const endedStream = await Promise.race([
    streamReader.read(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("guest stream did not close after revoke")),
        4500
      )
    ),
  ]);
  check(
    endedStream.done,
    "revocation closes idle guest SSE within five seconds"
  );
  check(
    (
      await request(guest(editor.artifactId, "open"), {
        headers: { Cookie: editorCookie },
      })
    ).status === 404,
    "revoked guest request refused"
  );
  await db
    .prepare(
      "UPDATE guest_sessions SET expires_at=? WHERE guest_id=(SELECT guest_id FROM artifact_members WHERE id=?)"
    )
    .bind(new Date(Date.now() - 1000).toISOString(), viewer.memberId)
    .run();
  await new Promise((done) => setTimeout(done, 4500));
  check(
    second.socket.readyState >= 2,
    `idle socket closes on current session expiry: ${await (await request(`/fixture/diagnostics/${editor.artifactId}`)).text()}`
  );
  const switched = await post("/fixture/switch", {});
  check(switched.ok, "admin workspace switch composed");
  await new Promise((done) => setTimeout(done, 1000));
  check(
    laterSocket.socket.readyState >= 2,
    "workspace disable closes remaining guest socket"
  );
  second.socket.close();
  laterSocket.socket.close();
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  await db.exec("DROP TRIGGER fixture_fail_guest;");
  const recovered = await post(`/fixture/checkpoint/${editor.artifactId}`, {});
  assert.equal(recovered.status, 200, await recovered.clone().text());
  const version = await db
    .prepare(
      "SELECT author_kind,author_id FROM artifact_versions WHERE artifact_id=? AND number=2"
    )
    .bind(editor.artifactId)
    .first();
  const original = await db
    .prepare("SELECT guest_id FROM artifact_members WHERE id=?")
    .bind(editor.memberId)
    .first();
  check(
    version.author_kind === "guest" && version.author_id === original.guest_id,
    "restart retry preserves original admitted guest attribution despite later editor and revoke"
  );
  check(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM artifact_versions WHERE artifact_id=? AND number=2"
        )
        .bind(editor.artifactId)
        .first()
    ).n === 1,
    "guest checkpoint recovery is idempotent"
  );
  await db
    .prepare("UPDATE workspaces SET live_guests_enabled=1 WHERE id='w1'")
    .run();
  const emergency = await create(
    "emergency@example.com",
    "viewer",
    editor.artifactId
  );
  await post(`/api/guest/${emergency.token}/code`, {});
  const emergencyMails = await (await request("/fixture/mail")).json();
  const emergencyCode = emergencyMails.at(-1).text.match(/\n(\d{6})\n/)[1];
  await runtime.dispose();
  options.bindings.LIVE_GUESTS_OFF = "1";
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  check(
    (
      await post(`/api/guest/${emergency.token}/verify`, {
        code: emergencyCode,
      })
    ).status === 404,
    "emergency switch refuses a correct pending code"
  );
  check(
    (await post(guest(editor.artifactId, "join"), {}, laterCurrentCookie))
      .status === 404,
    "emergency switch refuses guest room joins"
  );
  check(
    (await post("/api/guest/unknown/code", {})).status === 200,
    "unknown sendcode remains indistinguishable"
  );
  const signedOut = await post("/api/guest/signout", {}, laterCurrentCookie);
  check(
    signedOut.ok && signedOut.headers.get("Set-Cookie").includes("Max-Age=0"),
    "signout clears host cookie even when guest emergency switch is off"
  );
  check(
    (
      await db
        .prepare(
          "SELECT count(*) n FROM guest_sessions WHERE guest_id=(SELECT guest_id FROM artifact_members WHERE id=?)"
        )
        .bind(later.memberId)
        .first()
    ).n === 0,
    "signout deletes real persisted session"
  );
  replica.destroy();
  console.log(JSON.stringify({ passed }));
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
