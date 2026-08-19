/**
 * End-to-end check of the agent browser against the real Browser Run binding,
 * run against a local dev server:
 *
 *   bunx vite dev --mode e2e --port 3200 --strictPort     (in one terminal)
 *   bun run browser-spike                                 (from apps/web)
 *
 * It creates an agent through the authenticated API, drives that agent's MCP
 * tools exactly as the real agent would (navigate, snapshot, click, screenshot),
 * and then reads the results back through the user-facing `/api` routes - the
 * screenshots list, the PNG itself, the status endpoint and the activity log.
 *
 * The load-bearing assertion is the second one: `browser_snapshot` is called
 * without navigating first, in a separate Worker invocation, and must still see
 * the page the previous call opened. That is Browser Run session reuse working;
 * without it the agent's browser would forget its page between tool calls.
 *
 * The browser binding is `remote: true`, so this needs Cloudflare credentials -
 * `wrangler login` plus CLOUDFLARE_ACCOUNT_ID in apps/web/.env.local.
 * `--mode e2e` only keeps the server off the Anthropic API; the browser does
 * not care either way.
 */

import process from "node:process";
import { createClerkClient } from "@clerk/backend";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.SPIKE_BASE_URL ?? "http://localhost:3200";
const START_URL = "https://example.com";
/** A page with a real form on it, for browser_fill. */
const FORM_URL = "https://en.wikipedia.org/wiki/Main_Page";
const PNG_MAGIC = "\x89PNG";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const check = (label: string, passed: boolean, detail: string): void => {
  say(`${passed ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!passed) {
    throw new Error(`${label} failed`);
  }
};

/** A real Clerk session token for the dev user, so `/api` accepts the script. */
const userToken = async (): Promise<{
  jwt: string;
  revoke: () => Promise<void>;
}> => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const email = process.env.DEV_LOGIN_EMAIL;
  if (!(secretKey && email)) {
    throw new Error(
      "CLERK_SECRET_KEY and DEV_LOGIN_EMAIL must be set in apps/web/.env.local."
    );
  }

  const clerk = createClerkClient({ secretKey });
  const { data } = await clerk.users.getUserList({ emailAddress: [email] });
  const [user] = data;
  if (!user) {
    throw new Error(
      `No Clerk user for ${email}. Run "bun run create-dev-user" first.`
    );
  }

  const session = await clerk.sessions.createSession({ userId: user.id });
  const { jwt } = await clerk.sessions.getToken(session.id);
  return {
    jwt,
    revoke: async () => {
      await clerk.sessions.revokeSession(session.id);
    },
  };
};

const api = async (
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`
    );
  }
  return response;
};

/** Tool results come back as a single JSON text block. */
const toolJson = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ arguments: args, name });
  const [block] = result.content as { text: string; type: string }[];
  if (result.isError || !block) {
    throw new Error(`${name} failed: ${block?.text}`);
  }
  return JSON.parse(block.text) as Record<string, unknown>;
};

/** The refusal text of a tool call that was supposed to be refused. */
const toolRefusal = async (
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> => {
  const result = await client.callTool({ arguments: args, name });
  const [block] = result.content as { text: string }[];
  if (!(result.isError && block)) {
    throw new Error(`${name} was expected to fail but returned ${block?.text}`);
  }
  return block.text;
};

const main = async (): Promise<void> => {
  const { jwt: token, revoke } = await userToken();
  say(`server:  ${BASE_URL}`);

  const created = await api(token, "/api/agents", {
    body: JSON.stringify({
      name: `browser-spike-${Date.now().toString(36)}`,
      soul: "A test agent that only browses the web.",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const { agent, mcpUrl } = (await created.json()) as {
    agent: { id: string; name: string };
    mcpUrl: string;
  };
  say(`agent:   ${agent.name} (${agent.id})`);

  // The registered MCP URL points at PUBLIC_APP_URL; only the token matters.
  const mcpToken = new URL(mcpUrl).pathname.split("/").pop() ?? "";
  const client = new Client({ name: "browser-spike", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp/${mcpToken}`))
  );

  const tools = await client.listTools();
  say(
    `tools:   ${tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("browser_"))
      .sort()
      .join(", ")}`
  );

  const navigated = await toolJson(client, "browser_navigate", {
    url: START_URL,
  });
  check(
    "navigate",
    navigated.title === "Example Domain",
    JSON.stringify(navigated.title)
  );

  // The point of the whole session layer: a separate MCP call, a separate
  // Worker invocation, and the page from the last call is still open.
  const snapshot = (await toolJson(client, "browser_snapshot")) as {
    links: { href: string; text: string }[];
    text: string;
    url: string;
  };
  check(
    "snapshot reuses the session",
    snapshot.text.includes("Example Domain") &&
      snapshot.url === "https://example.com/",
    `${snapshot.url} - ${snapshot.text.slice(0, 60).replace(/\n/g, " ")}`
  );
  say(
    `links:   ${snapshot.links.map((link) => `${link.text} -> ${link.href}`).join(", ")}`
  );

  const clicked = await toolJson(client, "browser_click", {
    selector: "a[href]",
  });
  check(
    "click follows the link",
    typeof clicked.url === "string" && clicked.url !== START_URL,
    String(clicked.url)
  );

  // example.com has no form, so fill needs a page that does.
  await toolJson(client, "browser_navigate", { url: FORM_URL });
  const filled = (await toolJson(client, "browser_fill", {
    selector: 'input[name="search"]',
    value: "Cloudflare",
  })) as { filled: string; url: string };
  check(
    "fill types into a real field",
    filled.filled === 'input[name="search"]',
    JSON.stringify(filled)
  );

  const missing = await toolRefusal(client, "browser_fill", {
    selector: "input#nothing-here",
    value: "hello",
  });
  check(
    "fill reports a missing field",
    missing.length > 0,
    missing.slice(0, 80)
  );

  const refusedUrl = await toolRefusal(client, "browser_navigate", {
    url: "http://169.254.169.254/latest/meta-data/",
  });
  check("SSRF guard", refusedUrl.includes("private"), refusedUrl);

  const shot = (await toolJson(client, "browser_screenshot")) as {
    markdown: string;
    pageUrl: string;
    url: string;
  };
  check("screenshot", shot.url.includes("/browser/screenshots/"), shot.url);
  say(`markdown: ${shot.markdown}`);

  // The same screenshot, now through the user-facing API.
  const listed = await api(
    token,
    `/api/agents/${agent.id}/browser/screenshots`
  );
  const { screenshots } = (await listed.json()) as {
    screenshots: { id: string; pageUrl: string; size: number; url: string }[];
  };
  const [stored] = screenshots;
  if (!stored) {
    throw new Error("The screenshots API returned nothing.");
  }
  check(
    "screenshots API lists it",
    screenshots.length === 1 && shot.url.endsWith(stored.url),
    JSON.stringify(stored)
  );

  const image = await api(token, stored.url);
  const bytes = new Uint8Array(await image.arrayBuffer());
  check(
    "screenshot streams from R2",
    image.headers.get("content-type") === "image/png" &&
      String.fromCharCode(...bytes.slice(0, 4)) === PNG_MAGIC,
    `${image.headers.get("content-type")}, ${bytes.byteLength} bytes`
  );

  const status = (await (
    await api(token, `/api/agents/${agent.id}/browser/status`)
  ).json()) as {
    available: boolean;
    currentUrl: string;
    sessionActive: boolean;
  };
  check(
    "status",
    status.available && status.sessionActive && status.currentUrl.length > 0,
    JSON.stringify(status)
  );

  const activity = await api(token, `/api/agents/${agent.id}/activity`);
  const { entries } = (await activity.json()) as {
    entries: { kind: string; summary: string }[];
  };
  say("activity:");
  for (const entry of entries) {
    say(`  ${entry.kind.padEnd(19)} ${entry.summary}`);
  }
  const kinds = new Set(entries.map((entry) => entry.kind));
  check(
    "activity log",
    [
      "browser.navigate",
      "browser.click",
      "browser.fill",
      "browser.screenshot",
    ].every((kind) => kinds.has(kind)),
    [...kinds].join(", ")
  );

  await client.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" });
  await revoke();
  say(`\ncleaned up agent ${agent.id}`);
};

await main();
