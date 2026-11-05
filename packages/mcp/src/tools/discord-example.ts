// Kept as publishable files so the MCP example and the real Worker e2e use
// the same handler. Replace these public identifiers before publishing.
export const discordBotFiles = ({
  agentId = "AGENT_ID",
  applicationId = "APPLICATION_ID",
  publicKey = "DISCORD_PUBLIC_KEY_HEX",
  roleId = "ROLE_ID",
} = {}) => [
  { path: "index.html", text: "<!doctype html><title>Discord bot</title>" },
  {
    path: "agentum.json",
    text: JSON.stringify({
      agents: [{ agent: agentId }],
      endpoints: [{ name: "discord" }],
      hosts: ["discord.com"],
      secrets: ["DISCORD_BOT_TOKEN"],
    }),
  },
  {
    path: "server/index.js",
    text: `const PUBLIC_KEY = ${JSON.stringify(publicKey)};
const APPLICATION_ID = ${JSON.stringify(applicationId)};
const AGENT_ID = ${JSON.stringify(agentId)};
const ROLE_ID = ${JSON.stringify(roleId)};
const hex = (value) => Uint8Array.from(value.match(/../g) || [], (pair) => parseInt(pair, 16));
const segment = encodeURIComponent;
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    const signature = request.headers.get("x-signature-ed25519") || "";
    const timestamp = request.headers.get("x-signature-timestamp") || "";
    const body = await request.text();
    if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return new Response("Invalid signature", { status: 401 });
    }
    const key = await crypto.subtle.importKey("raw", hex(PUBLIC_KEY), "Ed25519", false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", key, hex(signature), new TextEncoder().encode(timestamp + body)))) {
      return new Response("Invalid signature", { status: 401 });
    }
    const interaction = JSON.parse(body);
    if (interaction.type === 1) return Response.json({ type: 1 });
    if (interaction.type !== 2) return new Response("Unsupported interaction", { status: 400 });
    if (interaction.data.name === "role") {
      if (!interaction.guild_id || !interaction.member?.user?.id) return Response.json({ type: 4, data: { content: "Use /role in a server.", flags: 64 } });
      ctx.waitUntil((async () => {
        const response = await fetch("https://discord.com/api/v10/guilds/" + segment(interaction.guild_id) + "/members/" + segment(interaction.member.user.id) + "/roles/" + segment(ROLE_ID), {
          method: "PUT"
        });
        if (!response.ok) throw new Error("Role update failed");
        const followup = await fetch("https://discord.com/api/v10/webhooks/" + segment(APPLICATION_ID) + "/" + segment(interaction.token) + "/messages/@original", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Role added.", allowed_mentions: { parse: [] } })
        });
        if (!followup.ok) throw new Error("Discord follow-up failed");
      })());
      return Response.json({ type: 5, data: { flags: 64 } });
    }
    if (interaction.data.name === "ask") {
      const text = interaction.data.options?.find((option) => option.name === "question")?.value;
      if (typeof text !== "string" || !text.trim()) return new Response("question required", { status: 400 });
      ctx.waitUntil(env.AGENTUM.startRun({ agent: AGENT_ID, text, state: interaction.token, sessionKey: interaction.channel_id }));
      return Response.json({ type: 5 });
    }
    return new Response("Unknown command", { status: 400 });
  },
  async reply({ status, text, state }, env) {
    const response = await fetch("https://discord.com/api/v10/webhooks/" + segment(APPLICATION_ID) + "/" + segment(state) + "/messages/@original", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: (status === "finished" ? text : "The agent " + status + ".").slice(0, 2000), allowed_mentions: { parse: [] } })
    });
    if (!response.ok) throw new Error("Discord follow-up failed");
  }
};`,
  },
];

export const DISCORD_EXAMPLE = `Discord example: replace AGENT_ID using list_agents, APPLICATION_ID, ROLE_ID and DISCORD_PUBLIC_KEY_HEX with your Discord application's values. A person must save a proxy secret DISCORD_BOT_TOKEN with rule {host:"discord.com", header:"Authorization", template:"Bot {value}"} and approve the app grants in Needs you. Register /role and /ask (string option question) with Discord separately. sessionKey: channel_id shares one agent session per channel. Publish these files, then use the approved endpoint URL from artifact_read as Discord's interactions URL.\n${discordBotFiles()
  .map((file) => `${file.path}:\n${file.text}`)
  .join("\n")}`;

export const APP_GUIDE =
  'app: ship index.html, server/index.js (JavaScript) and agentum.json. A bot needs only a one-line index.html. The default export supplies fetch(request, env) and optional reply({runId, status, text, fileIds, state}, env). The endpoint may serve any HTTP method, including GET. agentum.json declares hosts, secrets, endpoints: [{name}], and agents: [{agent: agentId}]. Limit: 5 endpoints and 5 agents. Endpoint names match ^[a-z0-9-]{1,40}$. agents takes the id from list_agents, not the slug. If there are no agents, call create_agent with a model, or ask a person to create one. New grants wait for browser approval in Needs you. artifact_read returns the requested version’s grants with status pending, approved or rejected. Approved endpoints have /hooks/<id> addresses in app settings and artifact_read. The app must check its caller’s signature; Agentum does not verify it. Only endpoint requests can call env.AGENTUM.startRun({agent, text, state?, sessionKey?}); it returns {runId} without waiting. state is a string up to 4096 characters; sessionKey is up to 169 characters. reply status values: finished, failed, cancelled, interrupted. Reply delivery uses the live version, is not retried, and is ignored if reply is absent. Durable storage: env.AGENTUM.getItem(area, key), setItem(area, key, value), listItems(area, prefix?, limit?), deleteItem(area, key). Values are strings; JSON.stringify and JSON.parse structured data. Use area "shared" in endpoint and reply code. Keep durable state in storage; module-level variables are not durable across requests. For proxy secrets, a person saves the secret with its host rule in Passwords and keys and approves the app’s secret and host grants. The platform sets the rule’s header on requests to that host. The app writes no token. Never put secret values in files.';
