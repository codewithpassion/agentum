import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "#/db/client";
import { AGENT_MODEL } from "#/modules/anthropic/config";
import {
  clearOverride,
  getOverride,
  resolveModel,
  upsertOverride,
} from "./model-overrides";
import { agentModelOverrides, agents } from "./schema";
import { createAgent } from "./service";

/**
 * The resolution order every surface runs on: thread -> channel -> the agent's
 * own model -> the workspace default. Against the shipped migrations, so the
 * `''` sentinel that makes the unique index dedupe channel-level rows is tested
 * as the database actually stores it.
 */

/** A bare id: `agents.workspace_id` is a tenant boundary, not a foreign key. */
const WORKSPACE_ID = "workspace-1";
const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";
const CHANNEL = "channel-1";
const THREAD = "message-1";

const migrate = (): Db => {
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
  return drizzle(sqlite) as unknown as Db;
};

let db: Db;
let agentId: string;

const setOverride = (model: string, threadParentId?: string) =>
  upsertOverride(db, {
    agentId,
    channelId: CHANNEL,
    createdBy: `agent:${agentId}`,
    model,
    threadParentId,
    workspaceId: WORKSPACE_ID,
  });

beforeEach(async () => {
  db = migrate();
  const { agent } = await createAgent(db, WORKSPACE_ID, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  agentId = agent.id;
});

describe("resolveModel", () => {
  test("falls back to the workspace default when nothing is set", async () => {
    expect(await resolveModel(db, { agentId, channelId: CHANNEL })).toBe(
      AGENT_MODEL
    );
  });

  test("takes the agent's own model next", async () => {
    await db.update(agents).set({ model: OPUS }).where(eq(agents.id, agentId));

    expect(
      await resolveModel(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: THREAD,
      })
    ).toBe(OPUS);
  });

  test("a channel override beats the agent's model, in and out of threads", async () => {
    await db.update(agents).set({ model: HAIKU }).where(eq(agents.id, agentId));
    await setOverride(OPUS);

    expect(await resolveModel(db, { agentId, channelId: CHANNEL })).toBe(OPUS);
    // A thread with no override of its own inherits its channel's.
    expect(
      await resolveModel(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: THREAD,
      })
    ).toBe(OPUS);
  });

  test("a thread override beats the channel's, and only in that thread", async () => {
    await setOverride(HAIKU);
    await setOverride(OPUS, THREAD);

    expect(
      await resolveModel(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: THREAD,
      })
    ).toBe(OPUS);
    expect(await resolveModel(db, { agentId, channelId: CHANNEL })).toBe(HAIKU);
    expect(
      await resolveModel(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: "message-2",
      })
    ).toBe(HAIKU);
  });

  test("another channel's override never reaches this one", async () => {
    await setOverride(OPUS);

    expect(await resolveModel(db, { agentId, channelId: "channel-2" })).toBe(
      AGENT_MODEL
    );
  });

  test("skips a stored model that is no longer in the catalog", async () => {
    // Rows outlive the list they were written against: a retired model must
    // fall through rather than be sent to the API.
    await db.update(agents).set({ model: OPUS }).where(eq(agents.id, agentId));
    await db.insert(agentModelOverrides).values({
      agentId,
      channelId: CHANNEL,
      createdBy: "agent:x",
      id: crypto.randomUUID(),
      model: "claude-retired-1",
      workspaceId: WORKSPACE_ID,
    });

    expect(await resolveModel(db, { agentId, channelId: CHANNEL })).toBe(OPUS);

    await db.update(agents).set({ model: "claude-retired-2" });
    expect(await resolveModel(db, { agentId, channelId: CHANNEL })).toBe(
      AGENT_MODEL
    );
  });
});

describe("upsertOverride", () => {
  test("stores a channel-level row under the '' sentinel", async () => {
    await setOverride(OPUS);

    const row = await getOverride(db, { agentId, channelId: CHANNEL });
    expect(row?.threadParentId).toBe("");
    expect(row?.model).toBe(OPUS);
  });

  test("replaces the conversation's model rather than adding a second row", async () => {
    await setOverride(OPUS);
    await setOverride(HAIKU);

    const rows = await db.select().from(agentModelOverrides);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe(HAIKU);
  });
});

describe("clearOverride", () => {
  test("deletes the row, so the conversation inherits again", async () => {
    await db.update(agents).set({ model: HAIKU }).where(eq(agents.id, agentId));
    await setOverride(OPUS, THREAD);

    expect(
      await clearOverride(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: THREAD,
      })
    ).toBe(true);
    expect(
      await resolveModel(db, {
        agentId,
        channelId: CHANNEL,
        threadParentId: THREAD,
      })
    ).toBe(HAIKU);
  });

  test("says so when there was nothing to clear", async () => {
    expect(await clearOverride(db, { agentId, channelId: CHANNEL })).toBe(
      false
    );
  });
});
