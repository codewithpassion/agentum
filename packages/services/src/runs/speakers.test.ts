import { beforeEach, expect, test } from "bun:test";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { sessionSupportsSpeakers } from "./speakers.ts";

const NOW = "2026-10-26T00:00:00.000Z";
const user = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
let db: ReturnType<typeof migrated>;
let agentId: string;

beforeEach(async () => {
  db = migrated();
  await db.insert(workspaces).values([
    {
      clerkOrgId: "org1",
      createdAt: NOW,
      id: "w1",
      name: "Test",
      timezone: "UTC",
    },
    {
      clerkOrgId: "org2",
      createdAt: NOW,
      id: "w2",
      name: "Other",
      timezone: "UTC",
    },
  ]);
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, { model: "m", name: "Cloud", runtime: "cloud" })
  ).id;
});

const seed = async (id: string, origin: string, workspaceId = "w1") => {
  await db.insert(sessions).values({
    actorId: "u1",
    actorKind: "user",
    agentId,
    createdAt: NOW,
    id,
    origin,
    private: false,
    workspaceId,
  });
};

test("artifact, slack and a2a sessions take speaker instructions", async () => {
  const origins = ["artifact", "slack", "a2a"];
  await Promise.all(origins.map((origin) => seed(`s-${origin}`, origin)));
  const answers = await Promise.all(
    origins.map((origin) =>
      sessionSupportsSpeakers(db, {
        sessionId: `s-${origin}`,
        workspaceId: "w1",
      })
    )
  );
  expect(answers).toEqual([true, true, true]);
});

test("other origins, unknown sessions and other workspaces do not", async () => {
  await Promise.all([
    seed("s-ui", "ui"),
    seed("s-mcp", "mcp"),
    seed("s-other", "a2a", "w2"),
  ]);
  const sessionIds = ["s-ui", "s-mcp", "s-other", "missing"];
  const answers = await Promise.all(
    sessionIds.map((sessionId) =>
      sessionSupportsSpeakers(db, { sessionId, workspaceId: "w1" })
    )
  );
  expect(answers).toEqual([false, false, false, false]);
});
