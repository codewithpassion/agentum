import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "#/db/client";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { agentActivity } = await import("#/modules/activity/schema");
const { agents } = await import("#/modules/agents/schema");
const { createAgent } = await import("#/modules/agents/service");
const { browserScreenshots } = await import("#/modules/browser/schema");
const { computerHosts } = await import("#/modules/computer/schema");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { captureDesktop } = await import("./desktop-capture");

const migrate = () => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return createDb({
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database);
};

interface Outcome {
  code: string | null;
  message: string;
  ok: boolean;
  reason: string | null;
  result_json: string | null;
}

const SHOT: Outcome = {
  code: null,
  message: "",
  ok: true,
  reason: null,
  result_json: JSON.stringify({
    data_b64: btoa("jpeg"),
    height: 800,
    media_type: "image/jpeg",
    width: 1280,
  }),
};

const setup = async (
  runtime: "cloudflare" | "managed",
  capabilities: Record<string, unknown> | null
) => {
  const db = migrate();
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_1",
      email: "a@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  const { agent: created } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Operator",
    runtime,
    soul: "",
  });
  await db.insert(computerHosts).values({
    capabilities,
    id: "host_1",
    kind: "self_hosted",
    name: "Box",
    workspaceId: workspace.id,
  });
  await db
    .update(agents)
    .set({ computer: "self_hosted", computerHostId: "host_1" })
    .where(eq(agents.id, created.id));
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, created.id));
  if (!agent) {
    throw new Error("agent missing");
  }
  return { agent, db, workspace };
};

describe("captureDesktop", () => {
  const run = async (outcome: Outcome) => {
    const { agent, db } = await setup("managed", { desktop: true });
    const requests: Record<string, unknown>[] = [];
    const puts: { key: string; type: string | undefined }[] = [];
    const env = {
      ATTACHMENTS: {
        put: (
          key: string,
          _body: unknown,
          options: { httpMetadata: { contentType: string } }
        ) => {
          puts.push({ key, type: options.httpMetadata.contentType });
          return Promise.resolve();
        },
      },
      COMPUTER_RELAY: {
        get: (hostId: string) => ({
          request: (message: Record<string, unknown>) => {
            requests.push({ ...message, hostId });
            return Promise.resolve(outcome);
          },
        }),
        idFromName: (name: string) => name,
      },
      PUBLIC_APP_URL: "https://app.example.com",
    } as unknown as Env;

    const result = await captureDesktop(db, env, agent);
    return { agent, db, puts, requests, result };
  };

  test("stores the JPEG, indexes and logs it, and returns it as base64", async () => {
    const { agent, db, puts, requests, result } = await run(SHOT);
    expect(requests[0]).toMatchObject({
      hostId: "host_1",
      op: "desktop_screenshot",
      quality: 60,
    });
    expect(puts).toHaveLength(1);
    const key = puts.map((put) => put.key).join("");
    expect(key.startsWith(`desktop/${agent.id}/`)).toBe(true);
    expect(puts.map((put) => put.type)).toEqual(["image/jpeg"]);

    const rows = await db.select().from(browserScreenshots);
    expect(rows.map((row) => row.r2Key)).toEqual([key]);
    const [activity] = await db.select().from(agentActivity);
    expect(activity).toMatchObject({
      kind: "computer.desktop",
      summary: "screenshot 1280x800",
    });

    expect(result).toEqual({
      base64: btoa("jpeg"),
      height: 800,
      mediaType: "image/jpeg",
      ok: true,
      width: 1280,
    });
  });

  test("tells the model what to do when the desktop is down", async () => {
    const { puts, result } = await run({
      code: "desktop_unavailable",
      message: "Xvfb exited",
      ok: false,
      reason: "client_error",
      result_json: null,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.text).toContain("use exec instead");
    expect(puts).toHaveLength(0);
  });
});
