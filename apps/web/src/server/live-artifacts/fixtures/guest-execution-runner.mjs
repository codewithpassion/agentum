// biome-ignore-all lint/style/useDestructuring: sequential scenario keeps named intermediate objects.
// biome-ignore-all lint/suspicious/noShadow: local ordered fixture scopes.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: standalone workerd executable test.
// biome-ignore-all lint/performance/noAwaitInLoops: ordered durable recovery fixture.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let script = "";
for await (const chunk of process.stdin) {
  script += chunk;
}
const directory = await mkdtemp(join(tmpdir(), "guest-execution-"));
const options = {
  bindings: {
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
    GUEST_RUN: { className: "GuestRun", useSQLite: true },
    LIVE_ARTIFACT_MAINTENANCE: {
      className: "LiveArtifactMaintenance",
      useSQLite: true,
    },
    SESSION_STREAM: { className: "SessionStream" },
  },
  modules: true,
  r2Buckets: ["FILES"],
  resourcePersistencePath: directory,
  script,
};
let runtime = new Miniflare(convertV4MiniflareOptions(options));
let checks = 0;
const check = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};
try {
  let db = await runtime.getD1Database("DB");
  for (const name of (
    await readdir(
      resolve(import.meta.dirname, "../../../../../../packages/db/migrations")
    )
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      resolve(
        import.meta.dirname,
        "../../../../../../packages/db/migrations",
        name
      ),
      "utf8"
    );
    await db.batch(
      sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s))
    );
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO workspaces(id,clerk_org_id,name,timezone,created_at) VALUES('w1','org_w1','Guest runtime','UTC',?)"
    )
    .bind(now)
    .run();
  await db
    .prepare(
      "INSERT INTO agents(id,workspace_id,created_by,created_at,instructions,model,name,runtime,runtime_config,slug,status) VALUES('a1','w1','u1',?,'PRIVATE MUST NEVER REACH GUEST','openrouter:z-ai/glm-5.3','Agent','cloud','{}','agent','active')"
    )
    .bind(now)
    .run();
  const request = (path, init = {}) =>
    runtime.dispatchFetch(`http://localhost${path}`, init);
  let cookie;
  const post = (path, body, withCookie = true) =>
    request(path, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        ...(withCookie && cookie ? { Cookie: cookie } : {}),
      },
      method: "POST",
    });
  const rotate = (response) => {
    const next = response.headers.get("Set-Cookie")?.split(";")[0];
    if (next) {
      cookie = next;
    }
  };
  const created = await post("/fixture/create", {}, false);
  assert.equal(created.status, 200, await created.clone().text());
  const invite = await created.json();
  const artifactId = invite.artifactId;
  await db
    .prepare("UPDATE artifacts SET agent_id='a1' WHERE id=?")
    .bind(artifactId)
    .run();
  const inviteToken = invite.mail
    .at(-1)
    .text.match(/(?:ag|hm)_invite_[A-Za-z0-9_-]+/)[0];
  await post(`/api/guest/${inviteToken}/code`, {}, false);
  const mail = await (await request("/fixture/mail")).json();
  const code = mail.at(-1).text.match(/\b\d{6}\b/)[0];
  const verified = await post(
    `/api/guest/${inviteToken}/verify`,
    { code },
    false
  );
  assert.equal(verified.status, 200, await verified.clone().text());
  rotate(verified);
  const ask = await post(`/api/guest/artifacts/${artifactId}/ask`, {
    requestId: "durable-one",
    text: "suggest a change",
  });
  assert.equal(ask.status, 200, await ask.clone().text());
  rotate(ask);
  const started = await ask.json();
  check(started.runId, "actual guest HTTP start");
  const retry = await post(`/api/guest/artifacts/${artifactId}/ask`, {
    requestId: "durable-one",
    text: "suggest a change",
  });
  rotate(retry);
  assert.equal((await retry.json()).runId, started.runId);
  checks += 1;
  for (let i = 0; i < 4; i += 1) {
    const response = await post(`/fixture/advance/${started.runId}`, {}, false);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const pending = await (await request("/fixture/requests")).json();
  check(pending.length === 1, "owner NeedsYou sees durable guest approval");
  const before = await (
    await request(`/fixture/state/${started.runId}`)
  ).json();
  check(
    before.phase === "approval" && before.requestId,
    "approval intent persisted"
  );
  const nativeResponse = await post(`/api/guest/artifacts/${artifactId}/ask`, {
    requestId: "native-refused",
    text: "try native",
  });
  rotate(nativeResponse);
  check(
    nativeResponse.status === 200,
    "second guest ask is durably queued behind held owner approval"
  );
  const denied = await nativeResponse.json();
  await post(`/fixture/advance/${denied.runId}`, {}, false);
  const queued = await db
    .prepare("SELECT status FROM runs WHERE id=?")
    .bind(denied.runId)
    .first();
  const queuedState = await (
    await request(`/fixture/state/${denied.runId}`)
  ).json();
  check(
    queued.status === "queued" && !queuedState.failures,
    "queue contention does not consume executor failure budget or infer"
  );
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  const after = await (await request(`/fixture/state/${started.runId}`)).json();
  check(
    after.requestId === before.requestId,
    "approval survives full worker restart"
  );
  const answer = await post(`/fixture/answer/${before.requestId}`, {}, false);
  assert.equal(answer.status, 200, await answer.clone().text());
  const probe = await post(`/fixture/probe/${started.runId}`, {}, false);
  check(
    probe.status === 200 && (await probe.json()).refused === 4,
    "real scoped token rejects native/foreign MCP and unsupported direct service effects"
  );
  const recoveredEffect = await post(
    `/fixture/recover/${started.runId}`,
    {},
    false
  );
  check(
    recoveredEffect.status === 200,
    "room effect retries stable durable step after lost executor acknowledgement"
  );
  for (let i = 0; i < 7; i += 1) {
    const response = await post(`/fixture/advance/${started.runId}`, {}, false);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const run = await db
    .prepare("SELECT * FROM runs WHERE id=?")
    .bind(started.runId)
    .first();
  check(
    run.status === "done",
    `durable restricted run completed (${run.status})`
  );
  check(
    run.actor_kind === "guest" &&
      run.on_behalf_of_user_id === null &&
      run.scope_artifact_id === artifactId,
    "immutable guest provenance"
  );
  const transcript = await request(
    `/api/guest/artifacts/${artifactId}/session`,
    { headers: { Cookie: cookie } }
  );
  rotate(transcript);
  const events = await transcript.json();
  check(
    JSON.stringify(events).includes("Captured guest completion"),
    "shared transcript contains real guarded guest output"
  );
  const suggestions = await request(
    `/api/guest/artifacts/${artifactId}/suggestions`,
    { headers: { Cookie: cookie } }
  );
  rotate(suggestions);
  const items = await suggestions.json();
  check(
    items.items.length === 1 && items.items[0].status === "pending",
    "actual guest model edit is a pending suggestion"
  );
  const capture = await runtime.getR2Bucket("FILES");
  const captures = await capture.list({
    prefix: `fixture-inference/${started.runId}/`,
  });
  for (const object of captures.objects) {
    const text = await (await capture.get(object.key)).text();
    check(
      !(
        text.includes("PRIVATE MUST") ||
        /(?:ag|hm)_run_/.test(text) ||
        /(?:ag|hm)_guest_/.test(text)
      ),
      "no private instructions or credentials in captured inference"
    );
  }
  const stream = await request(
    `/api/guest/artifacts/${artifactId}/session/stream?after=${encodeURIComponent(events.events[0].id)}`,
    { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }
  );
  rotate(stream);
  check(
    stream.status === 200 &&
      stream.headers.get("Content-Type").includes("text/event-stream"),
    "actual shared SSE route"
  );
  const reader = stream.body.getReader();
  let frames = "";
  while (!frames.includes("Captured guest completion")) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    frames += new TextDecoder().decode(next.value);
  }
  await reader.cancel();
  check(
    frames.includes("Captured guest completion"),
    "guarded completion delivered over shared SSE"
  );
  for (let i = 0; i < 4; i += 1) {
    await post(`/fixture/advance/${denied.runId}`, {}, false);
  }
  const nativeRun = await db
    .prepare("SELECT status FROM runs WHERE id=?")
    .bind(denied.runId)
    .first();
  check(
    nativeRun.status === "failed",
    "native tool proposal fails closed before effects"
  );
  const capped = await post(`/api/guest/artifacts/${artifactId}/ask`, {
    requestId: "over-cap",
    text: "read",
  });
  check(capped.status === 404, "actual HTTP daily cap refuses third run");

  cookie = undefined;
  const deckCreated = await (
    await post("/fixture/create", { kind: "deck" }, false)
  ).json();
  const deckId = deckCreated.artifactId;
  await db
    .prepare("UPDATE artifacts SET agent_id='a1' WHERE id=?")
    .bind(deckId)
    .run();
  const deckToken = deckCreated.mail
    .at(-1)
    .text.match(/(?:ag|hm)_invite_[A-Za-z0-9_-]+/)[0];
  await post(`/api/guest/${deckToken}/code`, {}, false);
  const deckMail = await (await request("/fixture/mail")).json();
  const deckCode = deckMail.at(-1).text.match(/\b\d{6}\b/)[0];
  const deckVerified = await post(
    `/api/guest/${deckToken}/verify`,
    { code: deckCode },
    false
  );
  rotate(deckVerified);
  const deckAsk = await post(`/api/guest/artifacts/${deckId}/ask`, {
    requestId: "deck-proposal",
    text: "suggest deck",
  });
  rotate(deckAsk);
  check(deckAsk.status === 200, "actual guest deck HTTP start");
  const deckRun = await deckAsk.json();
  for (let i = 0; i < 4; i += 1) {
    await post(`/fixture/advance/${deckRun.runId}`, {}, false);
  }
  const deckPending = await (await request("/fixture/requests")).json();
  check(deckPending.length === 1, "deck edit held in owner NeedsYou");
  const deckAnswer = await post(
    `/fixture/answer/${deckPending[0].id}`,
    {},
    false
  );
  check(deckAnswer.status === 200, "member approval resumes guest deck run");
  for (let i = 0; i < 7; i += 1) {
    await post(`/fixture/advance/${deckRun.runId}`, {}, false);
  }
  const deckSuggestions = await request(
    `/api/guest/artifacts/${deckId}/suggestions`,
    { headers: { Cookie: cookie } }
  );
  rotate(deckSuggestions);
  const deckItems = await deckSuggestions.json();
  check(
    deckItems.items.length === 1 && deckItems.items[0].status === "pending",
    "actual scoped deck MCP write stages a suggestion"
  );
  const held = await post(`/api/guest/artifacts/${deckId}/ask`, {
    requestId: "downgrade-held",
    text: "suggest again",
  });
  rotate(held);
  check(
    held.status === 200,
    "second deck run starts before current role change"
  );
  const heldRun = await held.json();
  for (let i = 0; i < 4; i += 1) {
    await post(`/fixture/advance/${heldRun.runId}`, {}, false);
  }
  await db
    .prepare(
      "UPDATE artifact_members SET role='viewer' WHERE artifact_id=? AND principal_kind='guest'"
    )
    .bind(deckId)
    .run();
  await post(`/fixture/advance/${heldRun.runId}`, {}, false);
  const stopped = await db
    .prepare("SELECT status FROM runs WHERE id=?")
    .bind(heldRun.runId)
    .first();
  check(
    stopped.status === "cancelled",
    "current downgrade cancels durable approval continuation"
  );
  const unchanged = await request(
    `/api/guest/artifacts/${deckId}/suggestions`,
    { headers: { Cookie: cookie } }
  );
  rotate(unchanged);
  check(
    (await unchanged.json()).items.length === 1,
    "downgraded run applies no additional suggestion"
  );

  for (const configuredRuntime of ["cloud", "machine", "managed"]) {
    for (const kind of ["document", "deck"]) {
      cookie = undefined;
      await db
        .prepare("UPDATE agents SET runtime=? WHERE id='a1'")
        .bind(configuredRuntime)
        .run();
      const created = await (
        await post(
          "/fixture/create",
          {
            email: `${configuredRuntime}-${kind}@example.com`,
            kind,
            role: "commenter",
          },
          false
        )
      ).json();
      const id = created.artifactId;
      await db
        .prepare("UPDATE artifacts SET agent_id='a1' WHERE id=?")
        .bind(id)
        .run();
      const token = created.mail
        .at(-1)
        .text.match(/(?:ag|hm)_invite_[A-Za-z0-9_-]+/)[0];
      await post(`/api/guest/${token}/code`, {}, false);
      const messages = await (await request("/fixture/mail")).json();
      const verified = await post(
        `/api/guest/${token}/verify`,
        { code: messages.at(-1).text.match(/\b\d{6}\b/)[0] },
        false
      );
      rotate(verified);
      const commentInput = {
        body: "Please answer this addressed comment",
        requestId: "addressed-one",
        toAgent: true,
      };
      const response = await post(
        `/api/guest/artifacts/${id}/comment`,
        commentInput
      );
      rotate(response);
      check(
        response.status === 200,
        `${configuredRuntime}/${kind} commenter addressed HTTP start`
      );
      const started = await response.json();
      const retry = await post(
        `/api/guest/artifacts/${id}/comment`,
        commentInput
      );
      rotate(retry);
      const replay = await retry.json();
      check(
        replay.runId === started.runId &&
          replay.id === started.id &&
          replay.threadId === started.threadId,
        "addressed retry reuses one charged run, comment and thread"
      );
      for (let i = 0; i < 4; i += 1) {
        await post(`/fixture/advance/${started.runId}`, {}, false);
      }
      const requests = await (await request("/fixture/requests")).json();
      check(
        requests.length === 1,
        "commenter agent comment enters durable member approval"
      );
      await post(`/fixture/answer/${requests[0].id}`, {}, false);
      const recovered = await post(
        `/fixture/recover/${started.runId}`,
        {},
        false
      );
      check(
        recovered.status === 200,
        "scoped comment effect survives lost acknowledgement with stable MCP call id"
      );
      const preview = await post(
        `/fixture/answer-preview/${started.runId}`,
        {},
        false
      );
      check(
        preview.status === 200,
        "answer chunks and acknowledgement replay idempotently before completion"
      );
      for (let i = 0; i < 6; i += 1) {
        await post(`/fixture/advance/${started.runId}`, {}, false);
      }
      const comments = await db
        .prepare(
          "SELECT * FROM artifact_comments WHERE thread_id=? ORDER BY created_at,id"
        )
        .bind(started.threadId)
        .all();
      const thread = await db
        .prepare("SELECT * FROM artifact_comment_threads WHERE id=?")
        .bind(started.threadId)
        .first();
      check(
        comments.results.length === 3 &&
          comments.results.filter((c) => c.author_kind === "agent").length ===
            2,
        "human addressed comment plus two distinct idempotent agent replies"
      );
      check(
        thread.answered_at &&
          thread.resolved_at === null &&
          thread.to_agent === 1,
        "agent answers original thread without resolving human discussion"
      );
      const run = await db
        .prepare("SELECT * FROM runs WHERE id=?")
        .bind(started.runId)
        .first();
      check(
        run.status === "done" &&
          run.actor_kind === "guest" &&
          run.on_behalf_of_user_id === null &&
          run.scope_artifact_id === id,
        `${configuredRuntime}/${kind} uses dedicated executor with guest provenance`
      );
      const ordinary = await post(`/api/guest/artifacts/${id}/comment`, {
        body: "A normal human comment",
      });
      rotate(ordinary);
      check(
        ordinary.status === 200,
        "ordinary human comment remains non-triggering"
      );
      const total = await db
        .prepare("SELECT count(*) n FROM runs WHERE scope_artifact_id=?")
        .bind(id)
        .first();
      check(
        total.n === 1,
        "normal comment and addressed retries create no extra runs"
      );
      const changed = await post(`/api/guest/artifacts/${id}/comment`, {
        ...commentInput,
        body: "Changed request payload",
      });
      rotate(changed);
      check(
        changed.status === 404,
        "reused addressed request cannot substitute a different human comment"
      );
      const held = await post(`/api/guest/artifacts/${id}/comment`, {
        body: "Held addressed request",
        requestId: "held-two",
        toAgent: true,
      });
      rotate(held);
      check(
        held.status === 200,
        "second addressed start charges the remaining daily slot atomically"
      );
      const heldStart = await held.json();
      const overCap = await post(`/api/guest/artifacts/${id}/comment`, {
        body: "Must not persist",
        requestId: "over-three",
        toAgent: true,
      });
      rotate(overCap);
      check(
        overCap.status === 404,
        "cap refusal leaves no addressed comment or thread"
      );
      const beforeLoss = await db
        .prepare(
          "SELECT count(*) n FROM artifact_comments c JOIN artifact_comment_threads t ON t.id=c.thread_id WHERE t.artifact_id=?"
        )
        .bind(id)
        .first();
      check(
        beforeLoss.n === 5,
        "failed addressed start rolls back comment and binding with the run"
      );
      await db
        .prepare(
          "UPDATE artifact_members SET role='viewer' WHERE artifact_id=? AND principal_kind='guest'"
        )
        .bind(id)
        .run();
      await post(`/fixture/advance/${heldStart.runId}`, {}, false);
      const revokedRun = await db
        .prepare("SELECT status FROM runs WHERE id=?")
        .bind(heldStart.runId)
        .first();
      const afterLoss = await db
        .prepare("SELECT count(*) n FROM artifact_comments WHERE thread_id=?")
        .bind(heldStart.threadId)
        .first();
      check(
        revokedRun.status === "cancelled" && afterLoss.n === 1,
        "current role loss prevents agent answer/comment effects after durable dispatch"
      );
    }
  }
  process.stdout.write(`${JSON.stringify({ checks, runId: started.runId })}\n`);
} finally {
  await runtime.dispose();
  await rm(directory, { force: true, recursive: true });
}
