/**
 * End-to-end check of the agent computer, run against a local dev server:
 *
 *   bunx vite dev --mode e2e --port 3200 --strictPort     (in one terminal)
 *   bun run computer-spike                                (from apps/web)
 *
 * It creates an agent through the authenticated API, drives that agent's MCP
 * tools exactly as the real agent would (write, edit, list, read, exec), and
 * then reads the same file back through the user-facing `/api` routes and the
 * activity log - proving the agent's writes and the user's view are the same
 * computer. No Anthropic call is involved: MCP tools work regardless.
 *
 * `--mode e2e` keeps the server off the Anthropic API; the computer does not
 * care either way.
 */

import process from "node:process";
import { createClerkClient } from "@clerk/backend";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.SPIKE_BASE_URL ?? "http://localhost:3200";
const FILE_PATH = "/notes/plan.md";
const CREATED = 201;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A real Clerk session token for the dev user, so `/api` accepts the script. */
const userToken = async (): Promise<{
  revoke: () => Promise<void>;
  jwt: string;
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
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ arguments: args, name });
  const [block] = result.content as { text: string; type: string }[];
  if (result.isError || !block) {
    throw new Error(`${name} failed: ${block?.text}`);
  }
  return JSON.parse(block.text) as Record<string, unknown>;
};

const main = async (): Promise<void> => {
  const { jwt: token, revoke } = await userToken();
  say(`server:  ${BASE_URL}`);

  const created = await api(token, "/api/agents", {
    body: JSON.stringify({
      name: `computer-spike-${Date.now().toString(36)}`,
      soul: "A test agent that only touches its own computer.",
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
  const client = new Client({ name: "computer-spike", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp/${mcpToken}`))
  );

  const tools = await client.listTools();
  const computerTools = tools.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("computer_"))
    .sort();
  say(`tools:   ${computerTools.join(", ")}`);

  const wrote = await toolJson(client, "computer_write_file", {
    content: "# Plan\n\n- [ ] draft\n",
    path: FILE_PATH,
  });
  say(`write:   ${JSON.stringify(wrote)}`);

  const edited = await toolJson(client, "computer_edit_file", {
    new_string: "- [x] draft",
    old_string: "- [ ] draft",
    path: FILE_PATH,
  });
  say(`edit:    ${JSON.stringify(edited)}`);

  const listed = await toolJson(client, "computer_list_dir", {
    path: "/notes",
  });
  say(`ls:      ${JSON.stringify(listed)}`);

  const read = await toolJson(client, "computer_read_file", {
    path: FILE_PATH,
  });
  say(`read:    ${JSON.stringify(read)}`);

  const ran = await toolJson(client, "computer_exec", {
    command: `wc -l ${FILE_PATH}`,
  });
  say(`exec:    ${JSON.stringify(ran)}`);

  const traversal = await client.callTool({
    arguments: { path: "/notes/../../etc/passwd" },
    name: "computer_read_file",
  });
  const [refusal] = traversal.content as { text: string }[];
  say(`refused: ${refusal?.text}`);

  // The same file, now through the user-facing API.
  const viaApi = await api(
    token,
    `/api/agents/${agent.id}/computer/file?path=${encodeURIComponent(FILE_PATH)}`
  );
  say(`api get: ${JSON.stringify(await viaApi.json())}`);

  const lsApi = await api(
    token,
    `/api/agents/${agent.id}/computer/ls?path=%2Fnotes`
  );
  say(`api ls:  ${JSON.stringify(await lsApi.json())}`);

  // A file the user puts on the agent's computer.
  const form = new FormData();
  form.set("file", new File(["from the user\n"], "brief.txt"));
  const uploaded = await api(token, `/api/agents/${agent.id}/computer/file`, {
    body: form,
    method: "POST",
  });
  if (uploaded.status !== CREATED) {
    throw new Error(`Upload returned ${uploaded.status}`);
  }
  say(`upload:  ${JSON.stringify(await uploaded.json())}`);

  const catUpload = await toolJson(client, "computer_exec", {
    command: "cat /uploads/brief.txt",
  });
  say(`agent sees upload: ${JSON.stringify(catUpload)}`);

  const activity = await api(token, `/api/agents/${agent.id}/activity`);
  const { entries } = (await activity.json()) as {
    entries: { kind: string; summary: string }[];
  };
  say("activity:");
  for (const entry of entries) {
    say(`  ${entry.kind.padEnd(14)} ${entry.summary}`);
  }

  await client.close();
  await api(token, `/api/agents/${agent.id}`, { method: "DELETE" });
  await revoke();
  say(`\ncleaned up agent ${agent.id}`);
};

await main();
