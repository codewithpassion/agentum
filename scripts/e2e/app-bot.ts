#!/usr/bin/env bun
/** biome-ignore-all lint/suspicious/noMisplacedAssertion: This standalone e2e script exits on a failed assertion. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Real vite dev Worker, MCP key, Clerk session consent, Dynamic Worker,
// Ed25519 ingress and app reply. The temporary Vite config redirects only
// AppOutbound's final transport to a local mock, after host/secret checks.
// It adds no route or configuration to the production app.
import { serve } from "bun";
import { discordBotFiles } from "../../packages/mcp/src/tools/discord-example";
import {
  createDeployment,
  freePort,
  queryRows,
  WEB_DIR,
  waitUntil,
} from "./a2a-harness";

const main = async () => {
  const workDir = await mkdtemp(join(tmpdir(), "agentum-app-bot-"));
  const calls: {
    path: string;
    method: string;
    auth: string | null;
    body: string;
  }[] = [];
  const mock = serve({
    async fetch(request) {
      calls.push({
        auth: request.headers.get("authorization"),
        body: await request.text(),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return new Response(null, { status: 204 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const configPath = join(WEB_DIR, `.app-bot-vite-${crypto.randomUUID()}.ts`);
  // Vite loads the config from this package so its plugin imports resolve.
  // Only the final fetch transport changes; the published bot stays identical.
  await writeFile(
    configPath,
    `import config from './vite.config.ts';
export default { ...config, plugins: [...config.plugins, {
  name: 'app-bot-transport', enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/app-gateway/entrypoints.ts')) return;
    const original = 'fetch: (outgoing) => fetch(outgoing),';
    if (!code.includes(original)) throw new Error('AppOutbound transport changed');
    return code.replace(original, 'fetch: (outgoing) => fetch(new Request(${JSON.stringify(`http://127.0.0.1:${mock.port}`)} + new URL(outgoing.url).pathname + new URL(outgoing.url).search, outgoing)),');
  }
}] };`
  );
  let port = await freePort();
  while (port === 3000) {
    // biome-ignore lint/performance/noAwaitInLoops: Retry only the explicitly excluded port.
    port = await freePort();
  }
  const deployment = createDeployment({
    name: "bot",
    port,
    viteConfig: configPath,
    workDir,
  });
  try {
    await deployment.start();
    const { person } = deployment;
    const key = await person.mutate<{ secret: string }>("apiKeys.create", {
      access: "write",
      name: "bot builder",
    });
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${deployment.origin}/mcp`, {
        body: JSON.stringify({
          id: crypto.randomUUID(),
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${key.secret}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const raw = await response.text();
      assert.equal(response.status, 200, raw);
      const data =
        raw.startsWith("event:") || raw.startsWith("data:")
          ? JSON.parse(
              raw
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice(6) ?? "{}"
            )
          : JSON.parse(raw);
      assert.ok(!(data.error || data.result?.isError), JSON.stringify(data));
      return data.result.structuredContent;
    };
    const agent = await person.mutate<{ id: string }>("agents.create", {
      model: "fake",
      name: "Bot answerer",
      runtime: "fake",
      slug: "bot-answerer",
    });
    await person.mutate("secrets.create", {
      mode: "proxy",
      name: "DISCORD_BOT_TOKEN",
      rules: [
        {
          header: "Authorization",
          host: "discord.com",
          template: "Bot {value}",
        },
      ],
      value: "e2e-discord-token",
    });
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey("raw", pair.publicKey)
    ).toString("hex");
    const created = await mcp("artifact_create", {
      files: discordBotFiles({
        agentId: agent.id,
        applicationId: "application",
        publicKey,
        roleId: "role",
      }),
      kind: "app",
      title: "Discord example",
    });
    assert.equal(
      (await mcp("artifact_promote", { artifactId: created.artifactId }))
        .status,
      "waiting"
    );
    const grants = await person.query<{ id: string; status: string }[]>(
      "artifacts.grants",
      { artifactId: created.artifactId, versionId: created.versionId }
    );
    assert.equal(grants.length, 4);
    assert.ok(grants.every((grant) => grant.status === "pending"));
    const rail = await person.query("desk.rail", {
      dayStart: new Date().toISOString(),
      scope: "mine",
    });
    assert.ok(JSON.stringify(rail).includes(created.artifactId));
    for (const grant of grants) {
      // biome-ignore lint/performance/noAwaitInLoops: Consent is a sequence of browser mutations.
      await person.mutate("artifacts.decideGrant", {
        decision: "approved",
        grantId: grant.id,
      });
    }
    assert.equal(
      (await mcp("artifact_promote", { artifactId: created.artifactId }))
        .status,
      "promoted"
    );
    const read = await mcp("artifact_read", { artifactId: created.artifactId });
    const url = read.endpoints[0]?.url;
    assert.ok(url?.startsWith(`${deployment.origin}/hooks/`));
    const signed = async (body: unknown, valid = true) => {
      const text = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = Buffer.from(
        await crypto.subtle.sign(
          "Ed25519",
          pair.privateKey,
          new TextEncoder().encode(timestamp + text)
        )
      ).toString("hex");
      return fetch(url, {
        body: text,
        headers: {
          "Content-Type": "application/json",
          "x-signature-ed25519": valid ? signature : "0".repeat(128),
          "x-signature-timestamp": timestamp,
        },
        method: "POST",
      });
    };
    assert.equal((await signed({ type: 1 }, false)).status, 401);
    assert.deepEqual(await (await signed({ type: 1 })).json(), { type: 1 });
    assert.deepEqual(
      await (
        await signed({
          data: { name: "role" },
          guild_id: "guild",
          member: { user: { id: "member" } },
          type: 2,
        })
      ).json(),
      { data: { content: "Role added.", flags: 64 }, type: 4 }
    );
    assert.deepEqual(calls[0], {
      auth: "Bot e2e-discord-token",
      body: "",
      method: "PUT",
      path: "/api/v10/guilds/guild/members/member/roles/role",
    });
    assert.deepEqual(
      await (
        await signed({
          channel_id: "channel",
          data: {
            name: "ask",
            options: [{ name: "question", value: "hello bot" }],
          },
          token: "interaction-token",
          type: 2,
        })
      ).json(),
      { type: 5 }
    );
    await waitUntil("Discord reply", 30_000, () =>
      calls.some((call) => call.method === "PATCH")
    );
    const reply = calls.find((call) => call.method === "PATCH");
    assert.equal(
      reply?.path,
      "/api/v10/webhooks/application/interaction-token/messages/@original"
    );
    assert.equal(JSON.parse(reply?.body ?? "{}").content, "Echo: hello bot");
    const [run] = queryRows<{
      on_behalf_of_user_id: string | null;
      reply: string;
    }>(
      deployment,
      "select on_behalf_of_user_id, reply from runs where agent_id = ?",
      agent.id
    );
    assert.equal(run?.on_behalf_of_user_id, null);
    assert.equal(JSON.parse(run?.reply ?? "{}").state, "interaction-token");
    const endpoints = await person.query<{ id: string }[]>(
      "artifacts.endpoints",
      { artifactId: created.artifactId }
    );
    await person.mutate("artifacts.changeEndpoint", {
      action: "disable",
      id: endpoints[0]?.id,
    });
    assert.equal((await signed({ type: 1 })).status, 404);
    assert.deepEqual(
      (await mcp("artifact_read", { artifactId: created.artifactId }))
        .endpoints,
      []
    );
    console.log(
      "PASS app-bot: MCP publish, browser-session grants, Ed25519, PING, role, agent reply, disable"
    );
  } finally {
    await deployment.stop();
    mock.stop(true);
    await rm(configPath, { force: true });
    console.log(`App bot logs: ${workDir}`);
  }
};

await main();
