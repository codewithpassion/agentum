import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith } from "../compose";
import { buildContext } from "./build-context";
import { appRouter } from "./router";

test("a session assistant creates an agent through the real MCP ports, services and audit", async () => {
  const db = migrated(["org_a"]);
  const bodies: unknown[] = [];
  const logs: string[] = [];
  const composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: async () => null,
        put: (_key, body) => {
          logs.push(body);
          return Promise.resolve();
        },
      },
      clock: systemClock,
      devFakeRuntime: true,
      fetch: (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          Response.json({
            content:
              bodies.length === 1
                ? [
                    {
                      id: "create_1",
                      input: {
                        instructions: "Help people",
                        model: "claude-haiku-5-5",
                        name: "Helper",
                        runtime: "cloud",
                        slug: "helper",
                      },
                      name: "create_agent",
                      type: "tool_use",
                    },
                  ]
                : [{ text: "Created Helper", type: "text" }],
          })
        );
      },
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
      secretsKey: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      validateAnthropicKey: async () => true,
    },
  });
  const principal = {
    isAdmin: false,
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: "ws_org_a",
  } as const;
  await composed.services.managedKeys.set(principal, {
    apiKey: "sk-ant-test-key",
  });
  await composed.services.secrets.create(principal, {
    allowedHosts: [],
    mode: "env",
    name: "TEST_TOKEN",
    value: "private-value-123",
  });
  const caller = appRouter.createCaller(
    await buildContext({
      composed,
      session: { orgId: "org_a", orgRole: "org:member", userId: "u1" },
    })
  );
  const chat = await caller.assistant.send({ text: "Create a helper" });
  expect(
    (await composed.services.agents.list(principal)).some(
      (agent) => agent.name === "Helper"
    )
  ).toBe(true);
  expect(JSON.stringify(chat)).toContain("create_agent");
  expect(JSON.stringify(chat)).toContain("Created Helper");
  const audit = await composed.services.events.list(principal, {
    types: ["admin.action"],
  });
  expect(audit.entries).toHaveLength(1);
  expect(audit.entries[0]?.actor).toEqual({ id: "u1", kind: "user" });
  for (const data of [chat, bodies, logs]) {
    expect(JSON.stringify(data)).not.toContain("private-value-123");
  }
  expect(await caller.assistant.list()).toHaveLength(1);
  expect((await caller.assistant.get({ conversationId: chat.id })).id).toBe(
    chat.id
  );
  const anonymous = appRouter.createCaller(
    await buildContext({ composed, session: { userId: null } })
  );
  await expect(anonymous.assistant.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  db.client.close();
});
