import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { files as fileRows } from "@repo/db/schema/files";
import { runs as runRows } from "@repo/db/schema/runs";
import { MAX_FILE_BYTES } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import {
  type MemoryFileBlobs,
  memoryFileBlobs,
} from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import {
  importRunTokenKey,
  RUN_TOKEN_MAX_AGE_MS,
  signRunToken,
} from "@repo/services/run-tokens";
import { systemClock } from "@repo/services/runs/types";
import type { Principal, Workspace } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { filesRoutes } from "./files.ts";
import type { AppEnv } from "./groups.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ORIGIN = "http://localhost";
const WORKER_ENV = { RUN_TOKEN_KEY: KEY };
const SAME_SITE = { "Sec-Fetch-Site": "same-origin" };
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const BOUNDARY = "harbourmaster-test-boundary";

interface Session {
  orgId: string | null;
  userId: string | null;
}
const USER_A: Session = { orgId: "org_a", userId: "user_a" };
const USER_B: Session = { orgId: "org_b", userId: "user_b" };

let db: ReturnType<typeof migrated>;
let composed: Composed;
let fileBlobs: MemoryFileBlobs;
let session: Session | null;
let workspaceA: Workspace;
let userA: Extract<Principal, { kind: "user" }>;
let userV: Extract<Principal, { kind: "user" }>;

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: false,
    fileBlobs,
    relay: noopRelay,
    runTokenKey: KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/", filesRoutes({ session: () => session }));

beforeEach(async () => {
  db = migrated(["org_a", "org_b"]);
  fileBlobs = memoryFileBlobs();
  session = USER_A;
  composed = composeWith({
    db,
    infra: infra(),
  });
  const a = await composed.services.workspaces.forOrg({ clerkOrgId: "org_a" });
  const b = await composed.services.workspaces.forOrg({ clerkOrgId: "org_b" });
  if (!(a && b)) {
    throw new Error("org_a and org_b must be allowed");
  }
  workspaceA = a;
  userA = { kind: "user", userId: "user_a", via: "session", workspaceId: a.id };
  userV = { kind: "user", userId: "user_v", via: "session", workspaceId: a.id };
});

const formOf = (file: File): FormData => {
  const form = new FormData();
  form.set("file", file);
  return form;
};

const textFile = (name: string, text = "hello", type = "text/plain") =>
  new File([text], name, { type });

const postForm = async (
  form: FormData,
  headers: Record<string, string> = SAME_SITE
): Promise<Response> =>
  await app.request(
    "/api/files",
    { body: form, headers, method: "POST" },
    WORKER_ENV
  );

const upload = (
  file: File,
  headers: Record<string, string> = SAME_SITE
): Promise<Response> => postForm(formOf(file), headers);

/** Uploads as the signed-in cookie session and returns the new file id. */
const uploadedId = async (file: File): Promise<string> => {
  const res = await upload(file);
  if (res.status !== 201) {
    throw new Error(`Upload answered ${res.status}`);
  }
  return ((await res.json()) as { id: string }).id;
};

const download = (id: string, headers: Record<string, string> = {}) =>
  app.request(`/files/${id}`, { headers }, WORKER_ENV);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const enrol = async (name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(userA, {
    machineName: name,
  });
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled;
};

/** A machine agent on a fresh machine, and a run of it that is claimed. Returns the run token. */
const claimedRun = async (fileIds: string[] = []) => {
  const { machineId } = await enrol("laptop");
  const agentId = (
    await composed.services.agents.create(userA, {
      machineId,
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).id;
  const { runId } = await composed.services.runs.startRun(userA, {
    agentId,
    input: { fileIds, text: "hi" },
    session: { origin: "ui" },
  });
  const claim = await composed.services.runs.claimRunForMachine(
    { kind: "machine", machineId, workspaceId: workspaceA.id },
    runId,
    { platformUrl: ORIGIN }
  );
  return { agentId, runId, runToken: claim.runToken };
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected the call to reject");
};

/** A multipart body of 52 MiB with no Content-Length, which is above the cap. */
const oversizeStream = (): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(head);
      for (let i = 0; i < 52; i += 1) {
        controller.enqueue(chunk);
      }
      controller.enqueue(tail);
      controller.close();
    },
  });
};

test("a run token downloads its listed input files, uploads its own output, and reads nothing else", async () => {
  const listed = await uploadedId(textFile("input.txt", "input"));
  const unlisted = await uploadedId(textFile("other.txt", "other"));
  session = USER_B;
  const foreign = await uploadedId(textFile("foreign.txt", "foreign"));
  session = USER_A;
  const { runId, runToken } = await claimedRun([listed]);

  const input = await download(listed, bearer(runToken));
  expect(input.status).toBe(200);
  expect(await input.text()).toBe("input");

  expect((await download(unlisted, bearer(runToken))).status).toBe(404);
  expect((await download(foreign, bearer(runToken))).status).toBe(404);
  expect(
    (await download("01JNOTAREALFILEID0000000000", bearer(runToken))).status
  ).toBe(404);

  const res = await upload(textFile("result.txt", "out"), bearer(runToken));
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).not.toHaveProperty("r2Key");
  const row = db
    .select()
    .from(fileRows)
    .where(eq(fileRows.id, body.id as string))
    .get();
  expect(row).toMatchObject({ runId, source: "run" });
});

test("a run token can download a file its run lists as output", async () => {
  const output = await uploadedId(textFile("report.txt", "report"));
  const { runId, runToken } = await claimedRun();
  expect((await download(output, bearer(runToken))).status).toBe(404);

  db.update(runRows)
    .set({ outputFileIds: JSON.stringify([output]) })
    .where(eq(runRows.id, runId))
    .run();

  const res = await download(output, bearer(runToken));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("report");
});

test("a user of workspace A gets 404 for a workspace B file and 200 for their own", async () => {
  const mine = await uploadedId(textFile("mine.txt", "mine"));
  session = USER_B;
  const theirs = await uploadedId(textFile("theirs.txt", "theirs"));

  session = USER_A;
  expect((await download(theirs)).status).toBe(404);
  const own = await download(mine);
  expect(own.status).toBe(200);
  expect(await own.text()).toBe("mine");
});

test("a composer upload cannot be attached to a run that another user starts", async () => {
  const { machineId } = await enrol("laptop");
  const agentId = (
    await composed.services.agents.create(userA, {
      machineId,
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).id;
  const fileId = await uploadedId(textFile("draft.txt"));

  const refused = await rejection(
    composed.services.runs.startRun(userV, {
      agentId,
      input: { fileIds: [fileId], text: "hi" },
      session: { origin: "ui" },
    })
  );
  expect(refused.code).toBe("not_found");

  const started = await composed.services.runs.startRun(userA, {
    agentId,
    input: { fileIds: [fileId], text: "hi" },
    session: { origin: "ui" },
  });
  expect(started.runId).toBeString();
});

test("a cross-site form post with a cookie session is refused and stores nothing", async () => {
  const res = await upload(textFile("evil.txt"), {
    Origin: "https://evil.example",
  });

  expect(res.status).toBe(403);
  expect(fileBlobs.objects.size).toBe(0);
  expect(db.select().from(fileRows).all()).toHaveLength(0);
});

test("same-origin form posts succeed, and a bearer run upload without an Origin header succeeds", async () => {
  const byOrigin = await upload(textFile("a.txt"), { Origin: ORIGIN });
  expect(byOrigin.status).toBe(201);
  const bySite = await upload(textFile("b.txt"), SAME_SITE);
  expect(bySite.status).toBe(201);

  const { runToken } = await claimedRun();
  const byRun = await upload(textFile("c.txt"), bearer(runToken));
  expect(byRun.status).toBe(201);
  expect(db.select().from(fileRows).all()).toHaveLength(3);
});

test("no session and no token answer 401 on both routes", async () => {
  const id = await uploadedId(textFile("kept.txt"));
  session = null;

  const posted = await upload(textFile("a.txt"));
  const fetched = await download(id);

  expect(posted.status).toBe(401);
  expect(await posted.json()).toEqual({ error: "Sign in required." });
  expect(fetched.status).toBe(401);
});

test("an invalid or expired run token answers 401 and does not fall back to a valid cookie session", async () => {
  session = USER_A;
  const id = await uploadedId(textFile("kept.txt"));
  const { agentId, runId } = await claimedRun();
  const key = await importRunTokenKey(KEY);
  const expired = await signRunToken(key, {
    agentId,
    issuedAt: Date.now() - RUN_TOKEN_MAX_AGE_MS - 60_000,
    runId,
    workspaceId: workspaceA.id,
  });

  for (const token of ["hm_run_nonsense.sig", "hm_mach_not_a_run", expired]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the order obvious
    const fetched = await download(id, bearer(token));
    expect(fetched.status).toBe(401);
    const posted = await upload(textFile("x.txt"), bearer(token));
    expect(posted.status).toBe(401);
  }
  expect(db.select().from(fileRows).all()).toHaveLength(1);
});

test("a body above the cap answers 413 and stores nothing, whether or not its length is declared", async () => {
  const declared = await app.request(
    "/api/files",
    {
      body: "x",
      headers: {
        ...SAME_SITE,
        "Content-Length": String(MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES + 1),
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      method: "POST",
    },
    WORKER_ENV
  );
  expect(declared.status).toBe(413);

  const streamed = await app.request(
    "/api/files",
    {
      body: oversizeStream(),
      headers: {
        ...SAME_SITE,
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      method: "POST",
    },
    WORKER_ENV
  );
  expect(streamed.status).toBe(413);

  const tooBigFile = new File(
    [new Uint8Array(MAX_FILE_BYTES + 1)],
    "huge.bin",
    { type: "application/octet-stream" }
  );
  const oversizeFile = await upload(tooBigFile);
  expect(oversizeFile.status).toBe(413);

  expect(fileBlobs.objects.size).toBe(0);
  expect(db.select().from(fileRows).all()).toHaveLength(0);
});

test("a request that is not a multipart form with a file field answers 400", async () => {
  const json = await app.request(
    "/api/files",
    {
      body: JSON.stringify({ file: "nope" }),
      headers: { ...SAME_SITE, "Content-Type": "application/json" },
      method: "POST",
    },
    WORKER_ENV
  );
  expect(json.status).toBe(400);

  const noFile = new FormData();
  noFile.set("note", "text only");
  const textOnly = await postForm(noFile);
  expect(textOnly.status).toBe(400);
  expect(db.select().from(fileRows).all()).toHaveLength(0);
});

test("an HTML file downloads as an attachment, a PNG renders inline, and each serves its stored type", async () => {
  const html = await uploadedId(
    textFile("page.html", "<script>x</script>", "text/html; charset=utf-8")
  );
  const png = await uploadedId(textFile("pixel.png", "png-bytes", "image/png"));

  const page = await download(html);
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Type")).toBe("text/html");
  expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(page.headers.get("Content-Disposition")).toStartWith(
    'attachment; filename="page.html"'
  );
  expect(page.headers.get("Content-Security-Policy")).toStartWith("sandbox;");
  expect(page.headers.get("Content-Length")).toBe("18");

  const image = await download(png);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(image.headers.get("Content-Disposition")).toStartWith("inline;");
});

test("a non-ASCII file name gets an ASCII fallback and a UTF-8 filename*", async () => {
  const id = await uploadedId(textFile("Résumé 2026.txt", "cv"));

  const res = await download(id);

  expect(res.headers.get("Content-Disposition")).toBe(
    `inline; filename="R_sum_ 2026.txt"; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.txt`
  );
});

test("a file name with an apostrophe or parentheses stays a valid filename*", async () => {
  const id = await uploadedId(textFile("Dom's (draft).txt", "x"));

  const res = await download(id);

  expect(res.headers.get("Content-Disposition")).toBe(
    `inline; filename="Dom's (draft).txt"; filename*=UTF-8''Dom%27s%20%28draft%29.txt`
  );
});
