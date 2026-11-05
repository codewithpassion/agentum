import { expect, test } from "bun:test";
import { HARNESS_SOURCE } from "./modules.ts";

test("the harness calls reply only when exported, with the host binding", async () => {
  const source = HARNESS_SOURCE.replace(
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "class WorkerEntrypoint { env = {}; ctx = {}; }"
  )
    .replace(
      'import app from "./server/index.js";',
      "const app = globalThis.__replyTestApp;"
    )
    .replace("export class Harness", "class Harness")
    .replace(
      'export default { fetch: () => new Response("use Harness", { status: 404 }) };',
      "return Harness;"
    );
  const globals = globalThis as typeof globalThis & { __replyTestApp?: object };
  const seen: unknown[] = [];
  try {
    globals.__replyTestApp = {
      reply: (message: unknown, env: unknown) => {
        seen.push({ env, message });
      },
    };
    const Harness = new Function(source)();
    await new Harness().reply(
      { state: "token", status: "finished", text: "done" },
      "host"
    );
    expect(seen).toEqual([
      {
        env: { AGENTUM: "host" },
        message: { state: "token", status: "finished", text: "done" },
      },
    ]);
    globals.__replyTestApp = {};
    const NoReply = new Function(source)();
    await new NoReply().reply({}, "host");
    globals.__replyTestApp = {
      reply: () => {
        throw new Error("boom");
      },
    };
    const Throws = new Function(source)();
    await expect(new Throws().reply({}, "host")).rejects.toThrow("boom");
  } finally {
    globals.__replyTestApp = undefined;
  }
});
