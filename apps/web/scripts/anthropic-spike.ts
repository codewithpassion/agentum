/**
 * Live probe of the Managed Agents API, run with the real key:
 *
 *   bun run anthropic-spike        (from apps/web)
 *
 * It proves the four things the router depends on - a reusable environment, an
 * agent plus memory store, a session seeded with `initial_events`, and polled
 * events with a client-side cursor - then cleans up after itself. No MCP server
 * is attached: Anthropic's cloud cannot reach a laptop, and this is about the
 * API shape, not our tools.
 */

import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { ENVIRONMENT_NAME } from "#/modules/anthropic/config";
import type { EventCursor } from "#/modules/anthropic/events";
import { isSessionReusable } from "#/modules/anthropic/events";
import { createAnthropicGateway } from "#/modules/anthropic/gateway";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;
const PROMPT = "Reply with exactly: pong";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to apps/web/.env.local."
    );
  }

  const client = new Anthropic({ apiKey });

  // A cache that forgets between calls, so the second ensureEnvironment() below
  // exercises the create -> 409 -> list -> reuse path for real.
  const gateway = createAnthropicGateway(client, {
    cache: {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
    },
    environmentName: ENVIRONMENT_NAME,
  });

  const first = await gateway.ensureEnvironment();
  const second = await gateway.ensureEnvironment();
  process.stdout.write(`environment (create-or-reuse): ${first}\n`);
  process.stdout.write(
    `environment (second call):     ${second} ${first === second ? "[reused]" : "[MISMATCH]"}\n`
  );

  const registered = await gateway.registerAgent({
    instructions: "Answer with a single word.",
    mcpUrl: "",
    name: `agentum-spike-${Date.now().toString(36)}`,
    system: "You are a terse test agent. Answer in exactly one word.",
  });
  process.stdout.write(`agent:        ${registered.anthropicAgentId}\n`);
  process.stdout.write(`memory store: ${registered.memoryStoreId}\n`);

  const session = await gateway.createSession({
    anthropicAgentId: registered.anthropicAgentId,
    memoryStoreId: registered.memoryStoreId,
    text: PROMPT,
    title: "Agentum spike",
  });
  process.stdout.write(`session:      ${session.sessionId}\n`);
  process.stdout.write(`status:       ${session.status}\n`);
  process.stdout.write(
    `trace:        https://platform.claude.com/workspaces/default/sessions/${session.sessionId}\n\n`
  );

  let cursor: EventCursor | undefined;
  let { status } = session;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Polling is a sequential loop by definition: each request starts where the
    // last one left off.
    // biome-ignore lint/performance/noAwaitInLoops: a poll loop is sequential by nature
    const page = await gateway.pollEvents(session.sessionId, cursor);
    ({ cursor } = page);
    for (const event of page.events) {
      process.stdout.write(
        `  ${event.type}${event.text ? `: ${event.text}` : ""}\n`
      );
    }
    status = await gateway.getSession(session.sessionId);
    if (!isSessionReusable(status) || status === "idle") {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  process.stdout.write(`\nfinal status: ${status}\n`);

  await gateway.deleteSession(session.sessionId);
  if (registered.memoryStoreId) {
    await client.beta.memoryStores.delete(registered.memoryStoreId);
  }
  // Agents have no delete - archive is the terminal state, which is what a
  // throwaway wants.
  await client.beta.agents.archive(registered.anthropicAgentId);
  process.stdout.write(
    "cleaned up: session deleted, memory store deleted, agent archived (environment kept)\n"
  );
};

await main();
