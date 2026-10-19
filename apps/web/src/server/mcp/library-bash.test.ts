import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type { McpPorts } from "@repo/mcp/ports";
import { memoryFileBlobs } from "@repo/services/files/memory";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "@repo/services/library/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");

let composed: Composed;
let blobs: MemoryLibraryBlobs;
let workspaceA: string;
let workspaceB: string;

const userOf = (workspaceId: string, userId = "u1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

const portsFor = (principal: Principal): McpPorts =>
  createMcpPorts({ principal, services: composed.services });

const bash = (principal: Principal, script: string) =>
  portsFor(principal).libraryBash({ script });

const commandEvents = async (workspaceId: string) =>
  (
    await composed.services.events.query(userOf(workspaceId), workspaceId, {
      types: ["library.command"],
    })
  ).map((event) => event);

beforeEach(async () => {
  const db = migrated();
  blobs = memoryLibraryBlobs();
  composed = composeWith({
    allowedOrgIds: ["org_a", "org_b"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      // A cloud agent starts through the cloud runtime, which needs a runner, a run token key and a base URL.
      clock: systemClock,
      cloudRunner: {
        cancel: () => Promise.resolve(),
        start: () => Promise.resolve(),
      },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      libraryBlobs: blobs,
      publicBaseUrl: "https://harbourmaster.example.com",
      relay: noopRelay,
      runTokenKey: RUN_TOKEN_KEY,
      secretsKey: SECRETS_KEY,
    },
  });
  const [a, b] = await Promise.all([
    composed.services.workspaces.forOrg({ clerkOrgId: "org_a" }),
    composed.services.workspaces.forOrg({ clerkOrgId: "org_b" }),
  ]);
  if (!(a && b)) {
    throw new Error("the test organisations are not allowed");
  }
  workspaceA = a.id;
  workspaceB = b.id;
});

test("files written by one call are there for the next call", async () => {
  const user = userOf(workspaceA);
  const first = await bash(user, "mkdir -p a && echo hi > a/x.md");
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe("");

  const cat = await bash(user, "cat a/x.md");
  expect(cat.stdout).toBe("hi\n");

  const grep = await bash(user, "grep -rn hi .");
  expect(grep.exitCode).toBe(0);
  expect(grep.stdout).toBe("a/x.md:1:hi\n");

  const sed = await bash(user, "sed -i s/hi/ho/ a/x.md && cat a/x.md");
  expect(sed.exitCode).toBe(0);
  expect(sed.stdout).toBe("ho\n");

  const count = await bash(user, "ls -R | wc -l");
  expect(count.exitCode).toBe(0);
  expect(count.stdout.trim()).toBe("5");
});

test("a script starts in /library, and files outside it are gone after the call", async () => {
  const user = userOf(workspaceA);
  const first = await bash(
    user,
    "pwd; echo scratch > /tmp/note.txt; cat /tmp/note.txt"
  );
  expect(first.stdout).toBe("/library\nscratch\n");
  const second = await bash(user, "cat /tmp/note.txt");
  expect(second.exitCode).not.toBe(0);
  expect(second.stderr).toContain("No such file");
});

test("a heredoc keeps its leading whitespace", async () => {
  const user = userOf(workspaceA);
  await bash(user, "cat > note.md <<'EOF'\n  indented\n    more\nEOF");
  const read = await bash(user, "cat note.md");
  expect(read.stdout).toBe("  indented\n    more\n");
});

test("a path that climbs out of the library fails and touches no key outside the workspace", async () => {
  await bash(userOf(workspaceB), "echo secret > x");
  const user = userOf(workspaceA);
  await bash(user, "echo mine > mine.md");
  const before = blobs.touched.length;
  const attempts = [
    "cat ../../other-ws/library/x",
    "cat /library/../../other-ws/library/x",
    `cat ../../${workspaceB}/library/x`,
    `ls ../../${workspaceB}/library`,
    "cat ../../../../x",
    `echo owned > ../../${workspaceB}/library/x`,
  ];
  for (const script of attempts) {
    // biome-ignore lint/performance/noAwaitInLoops: each attempt is a separate call
    const result = await bash(user, script);
    expect(result.stdout).not.toContain("secret");
    // A write lands in the call's scratch memory and succeeds there; every read fails.
    if (!script.startsWith("echo")) {
      expect(result.exitCode).not.toBe(0);
    }
  }
  expect((await bash(user, "cat ../../other-ws/library/x")).exitCode).not.toBe(
    0
  );
  // Those paths resolve in the call's scratch memory, so no key was read or written.
  expect(blobs.touched.slice(before)).toEqual([]);
  // A real read touches only this workspace's prefix.
  await bash(user, "cat mine.md");
  expect(
    blobs.touched
      .slice(before)
      .every((key) => key.startsWith(`${workspaceA}/library/`))
  ).toBe(true);
  expect((await blobs.get(`${workspaceB}/library/x`))?.bytes).toEqual(
    new TextEncoder().encode("secret\n")
  );
});

test("cp and mv from scratch into the library work", async () => {
  const user = userOf(workspaceA);
  const result = await bash(
    user,
    "echo one > /tmp/t && cp /tmp/t ./c1 && mv /tmp/t ./m1 && chmod 600 m1 && cat c1 m1 && ls /tmp"
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("one\none\n");
});

test("a loop that writes 3,000 files stops at the storage call budget with a clear error", async () => {
  const user = userOf(workspaceA);
  const result = await bash(
    user,
    "for i in $(seq 1 3000); do echo $i > f$i; done; echo after"
  );
  expect(result.stdout).not.toContain("after");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Storage call budget of 2000 exceeded");
  expect(result.storageCalls).toBeLessThanOrEqual(2000);
  const listed = await composed.services.library.list(user, "");
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.length).toBeLessThan(3000);
});

test("every call adds one library.command event, and the writes add their own", async () => {
  const user = userOf(workspaceA, "u7");
  await bash(user, "echo one > a.md");
  await bash(user, "cat missing.md");
  await bash(user, "ls");

  const commands = await commandEvents(workspaceA);
  expect(commands).toHaveLength(3);
  expect(commands.map((event) => event.payload.script)).toEqual([
    "echo one > a.md",
    "cat missing.md",
    "ls",
  ]);
  expect(commands.map((event) => event.payload.exitCode)).toEqual([0, 1, 0]);
  for (const event of commands) {
    expect(event.actor).toEqual({ id: "u7", kind: "user" });
    expect(typeof event.payload.wallMs).toBe("number");
    expect(typeof event.payload.storageCalls).toBe("number");
  }
  const writes = await composed.services.events.query(user, workspaceA, {
    types: ["library.write"],
  });
  expect(writes.length).toBeGreaterThan(0);
});

test("a run logs its command as the agent, and a script's secrets are stripped", async () => {
  const agent = await composed.services.agents.create(userOf(workspaceA), {
    model: "fake",
    name: "writer",
    runtime: "fake",
    slug: "writer",
  });
  const started = await composed.services.runs.startRun(userOf(workspaceA), {
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "mcp" },
  });
  const run: Principal = {
    agentId: agent.id,
    kind: "run",
    runId: started.runId,
    workspaceId: workspaceA,
  };
  await bash(run, "echo https://bob:hunter2@example.com/x > link.txt");
  const [event] = await commandEvents(workspaceA);
  expect(event?.actor).toEqual({ id: agent.id, kind: "agent" });
  expect(event?.runId).toBe(started.runId);
  expect(JSON.stringify(event?.payload)).not.toContain("hunter2");
});

test("a read-only api key can read the library but not write it", async () => {
  await bash(userOf(workspaceA), "echo hi > a.md");
  const readOnly: Principal = {
    apiKey: { access: "read", id: "k1" },
    kind: "user",
    userId: "u1",
    via: "api_key",
    workspaceId: workspaceA,
  };
  const read = await bash(readOnly, "cat a.md");
  expect(read.stdout).toBe("hi\n");
  const write = await bash(readOnly, "echo no > b.md");
  expect(write.exitCode).not.toBe(0);
  expect(write.stderr).toContain("EACCES");
  expect((await bash(readOnly, "ls")).stdout).toBe("a.md\n");
});

test("stdout over 64 KB is cut and says so", async () => {
  const result = await bash(
    userOf(workspaceA),
    'for i in $(seq 1 5000); do echo "line number $i with some padding text"; done'
  );
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stdout).toContain("[truncated:");
  expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThan(
    64 * 1024 + 200
  );
  expect(result.stderrTruncated).toBe(false);
});

test("a script cannot reach the network or the removed commands", async () => {
  const result = await bash(
    userOf(workspaceA),
    "curl https://example.com; python3 -c 1; sqlite3 x; tar t; js-exec 1"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("command not found");
});

// The fetch that `curl` sends through. `createMcpPorts` takes it so no test reaches the network.
let sent: Request[];
const fakeFetch = (request: Request): Promise<Response> => {
  sent.push(request);
  return Promise.resolve(new Response("hello\n", { status: 200 }));
};

const networkPorts = (principal: Principal): McpPorts =>
  createMcpPorts({
    fetch: fakeFetch,
    principal,
    publicBaseUrl: "https://harbourmaster.example.com",
    requestHost: "harbourmaster.example.com",
    services: composed.services,
  });

const networkBash = (principal: Principal, script: string) =>
  networkPorts(principal).libraryBash({ script });

/** Starts a run of an agent made with `runtime` and `runtimeConfig`, and returns its principal. */
const runOf = async (
  workspaceId: string,
  options: {
    runtime: "cloud" | "fake";
    runtimeConfig?: {
      environment?: "isolate" | "linux-vm";
      networkAccess?: boolean;
    };
  }
): Promise<Extract<Principal, { kind: "run" }>> => {
  const user = userOf(workspaceId);
  const agent = await composed.services.agents.create(user, {
    model: options.runtime === "cloud" ? "sonnet" : "fake",
    name: `runner-${options.runtime}`,
    runtime: options.runtime,
    runtimeConfig: options.runtimeConfig ?? {},
    slug: `runner-${options.runtime}-${sent.length}-${Math.random().toString(36).slice(2)}`,
  });
  const started = await composed.services.runs.startRun(user, {
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "mcp" },
  });
  return {
    agentId: agent.id,
    kind: "run",
    runId: started.runId,
    workspaceId,
  };
};

const networkEvents = async (workspaceId: string) =>
  composed.services.events.query(userOf(workspaceId), workspaceId, {
    types: ["network.request"],
  });

test("a run whose agent has network access gets curl through the fetcher, and the request is logged", async () => {
  sent = [];
  const run = await runOf(workspaceA, { runtime: "fake" });
  const result = await networkBash(run, "curl -s https://example.com/");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("hello\n");
  expect(sent.map((request) => request.url)).toEqual(["https://example.com/"]);

  const [event] = await networkEvents(workspaceA);
  expect(event?.runId).toBe(run.runId);
  expect(event?.payload.host).toBe("example.com");
  expect(event?.payload.status).toBe(200);
});

test("a run whose agent has network access off is refused by curl and never fetches", async () => {
  sent = [];
  const run = await runOf(workspaceA, {
    runtime: "cloud",
    runtimeConfig: { networkAccess: false },
  });
  const result = await networkBash(run, "curl -s https://example.com/");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Network access is off for this agent.");
  expect(sent).toEqual([]);
});

test("a Linux VM agent keeps curl whatever its network setting says", async () => {
  sent = [];
  const run = await runOf(workspaceA, {
    runtime: "cloud",
    runtimeConfig: { environment: "linux-vm", networkAccess: false },
  });
  const result = await networkBash(run, "curl -s https://example.com/");
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(1);
});

test("a user principal is refused by curl and never fetches", async () => {
  sent = [];
  const result = await networkBash(
    userOf(workspaceA),
    "curl -s https://example.com/"
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Network access is off for this agent.");
  expect(sent).toEqual([]);
});

test("curl refuses loopback and metadata addresses from an enabled run", async () => {
  sent = [];
  const run = await runOf(workspaceA, { runtime: "fake" });
  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each attempt is a separate call
    const result = await networkBash(run, `curl -s ${url}`);
    expect(result.exitCode).not.toBe(0);
  }
  expect(sent).toEqual([]);
});

test("a logged request keeps its query string and headers out of the event", async () => {
  sent = [];
  const run = await runOf(workspaceA, { runtime: "fake" });
  await networkBash(
    run,
    "curl -s -H 'Authorization: Bearer topsecret' 'https://example.com/a?token=querysecret'"
  );
  expect(sent).toHaveLength(1);
  const events = await networkEvents(workspaceA);
  expect(events).toHaveLength(1);
  const stored = JSON.stringify(events[0]?.payload);
  expect(stored).not.toContain("querysecret");
  expect(stored).not.toContain("topsecret");
  expect(stored).not.toContain("Bearer");
  expect(stored).not.toContain("token=");
});

/** The scripts the Log holds for the library commands of one run. */
const loggedScripts = async (run: Extract<Principal, { kind: "run" }>) => {
  const commands = await composed.services.events.query(
    userOf(workspaceA),
    workspaceA,
    { types: ["library.command"] }
  );
  return commands
    .filter((event) => event.runId === run.runId)
    .map((event) => (event.payload as { script: string }).script);
};

const SECRET = "topsecret-value";

test.each([
  [
    "a variable set on another line",
    `T=${SECRET}\ncurl -H "A: $T" https://example.com/`,
  ],
  [
    "a file written first",
    `echo '{"t":"${SECRET}"}' > b.json\ncurl -d @b.json https://example.com/`,
  ],
  [
    "a pipe over two lines",
    `echo '{"t":"${SECRET}"}' |\ncurl -d @- https://example.com/`,
  ],
  [
    "a spelling with a backslash",
    `c\\url -H "A: ${SECRET}" https://example.com/`,
  ],
  ["ANSI-C quoting", `curl -H $'A: ${SECRET}' https://example.com/`],
  ["backticks", `curl -H "A: \`echo ${SECRET}\`" https://example.com/`],
  [
    "a variable holding the command",
    `c=curl; $c -H "A: ${SECRET}" https://example.com/`,
  ],
  [
    "a request refused for its address",
    `curl -H "A: ${SECRET}" http://127.0.0.1/`,
  ],
  [
    "a curl that failed on its arguments",
    `curl --no-such-option -H "A: ${SECRET}"`,
  ],
])("the Log keeps no script that started curl: %s", async (_name, script) => {
  sent = [];
  const run = await runOf(workspaceA, { runtime: "fake" });
  await networkBash(run, script);
  expect(await loggedScripts(run)).toEqual([
    "[script redacted: made network requests]",
  ]);
});

test("curl with network access off still hides the script", async () => {
  const run = await runOf(workspaceA, {
    runtime: "cloud",
    runtimeConfig: { networkAccess: false },
  });
  await networkBash(run, `curl -H "A: ${SECRET}" https://example.com/`);
  expect(await loggedScripts(run)).toEqual([
    "[script redacted: made network requests]",
  ]);
});

test("a script that only mentions curl is logged as typed", async () => {
  const run = await runOf(workspaceA, { runtime: "fake" });
  const script = `# curl is not used here\necho "run curl later, token ${SECRET}"`;
  await networkBash(run, script);
  expect(await loggedScripts(run)).toEqual([script]);
});

const SUPADATA_VALUE = "supadata-real-value";

/** Stores an env secret and grants it to `agentId`, or leaves it ungranted when `grant` is false. */
const storeEnvSecret = async (
  workspaceId: string,
  agentId: string,
  {
    grant = true,
    name = "SUPADATA_KEY",
  }: { grant?: boolean; name?: string } = {}
) => {
  const user = userOf(workspaceId);
  const created = await composed.services.secrets.create(user, {
    allowedHosts: ["api.supadata.ai"],
    mode: "env",
    name,
    value: SUPADATA_VALUE,
  });
  if (grant) {
    await composed.services.secrets.setGrants(user, agentId, [created.id]);
  }
};

const cloudRunOf = (
  workspaceId: string,
  runtimeConfig: {
    environment?: "isolate" | "linux-vm";
    networkAccess?: boolean;
  } = {}
) => runOf(workspaceId, { runtime: "cloud", runtimeConfig });

test("an isolate agent with network access sees its granted env secret as a placeholder, never the value", async () => {
  sent = [];
  const run = await cloudRunOf(workspaceA);
  await storeEnvSecret(workspaceA, run.agentId);
  const result = await networkBash(run, "echo $SUPADATA_KEY");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("hm-secret:SUPADATA_KEY\n");
  expect(JSON.stringify(result)).not.toContain(SUPADATA_VALUE);
  const commands = await composed.services.events.query(
    userOf(workspaceA),
    workspaceA,
    { types: ["library.command"] }
  );
  expect(JSON.stringify(commands)).not.toContain(SUPADATA_VALUE);
});

test("curl sends the real value to an allowed host, and the shell output never shows it", async () => {
  sent = [];
  const run = await cloudRunOf(workspaceA);
  await storeEnvSecret(workspaceA, run.agentId);
  const result = await networkBash(
    run,
    'curl -s -H "x-api-key: $SUPADATA_KEY" https://api.supadata.ai/x'
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get("x-api-key")).toBe(SUPADATA_VALUE);
  expect(result.stdout).not.toContain(SUPADATA_VALUE);
  expect(result.stderr).not.toContain(SUPADATA_VALUE);
  expect(JSON.stringify(await networkEvents(workspaceA))).not.toContain(
    SUPADATA_VALUE
  );
});

test("curl refuses the placeholder for a host the secret may not reach", async () => {
  sent = [];
  const run = await cloudRunOf(workspaceA);
  await storeEnvSecret(workspaceA, run.agentId);
  const result = await networkBash(
    run,
    'curl -s -H "x-api-key: $SUPADATA_KEY" https://example.com/'
  );
  expect(result.exitCode).not.toBe(0);
  expect(sent).toEqual([]);
  expect(result.stdout).not.toContain(SUPADATA_VALUE);
  expect(result.stderr).not.toContain(SUPADATA_VALUE);
});

test("an isolate agent with network access off gets no variable", async () => {
  const run = await cloudRunOf(workspaceA, { networkAccess: false });
  await storeEnvSecret(workspaceA, run.agentId);
  const result = await networkBash(run, 'echo "[$SUPADATA_KEY]"');
  expect(result.stdout).toBe("[]\n");
});

test("a Linux VM agent gets no variable", async () => {
  const run = await cloudRunOf(workspaceA, { environment: "linux-vm" });
  await storeEnvSecret(workspaceA, run.agentId);
  const result = await networkBash(run, 'echo "[$SUPADATA_KEY]"');
  expect(result.stdout).toBe("[]\n");
});

test("a proxy-mode secret is not a variable", async () => {
  const run = await cloudRunOf(workspaceA);
  const user = userOf(workspaceA);
  const created = await composed.services.secrets.create(user, {
    mode: "proxy",
    name: "SUPADATA_KEY",
    rules: [
      { header: "x-api-key", host: "api.supadata.ai", template: "{value}" },
    ],
    value: SUPADATA_VALUE,
  });
  await composed.services.secrets.setGrants(user, run.agentId, [created.id]);
  const result = await networkBash(run, 'echo "[$SUPADATA_KEY]"');
  expect(result.stdout).toBe("[]\n");
});

test("a secret that is not granted to the agent is not a variable", async () => {
  const run = await cloudRunOf(workspaceA);
  await storeEnvSecret(workspaceA, run.agentId, { grant: false });
  const result = await networkBash(run, 'echo "[$SUPADATA_KEY]"');
  expect(result.stdout).toBe("[]\n");
});

test("when the placeholders cannot be read the shell runs without variables", async () => {
  const run = await cloudRunOf(workspaceA);
  await storeEnvSecret(workspaceA, run.agentId);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const resolve = spyOn(
    composed.services.secrets,
    "placeholdersFor"
  ).mockRejectedValueOnce(new Error("boom"));
  try {
    const result = await networkBash(run, 'echo "[$SUPADATA_KEY]"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
  } finally {
    resolve.mockRestore();
    warn.mockRestore();
  }
});
