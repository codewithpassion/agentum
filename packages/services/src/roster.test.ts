import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import { defaultAgentAvatar } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import { createRosterService } from "./roster.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const NOW = "2026-01-01T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createRosterService>;

const seedWorkspace = (conn: ReturnType<typeof migrated>, id: string) =>
  conn
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const insertAgent = (
  row: { id: string; name: string } & Partial<typeof agents.$inferInsert>
) =>
  db
    .insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      emailLocal: null,
      handsTo: "[]",
      instructions: "",
      machineId: null,
      model: "m",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: row.id,
      soul: "",
      status: "active",
      workspaceId: WORKSPACE,
      ...row,
    })
    .run();

beforeEach(() => {
  db = migrated();
  seedWorkspace(db, WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  service = createRosterService({ db });
});

test("lists active agents only, ordered by name, each as an idle stub card", async () => {
  insertAgent({
    avatar: '{"color":"blue","glyph":"Z"}',
    id: "a-zeta",
    name: "Zeta",
    soul: "  \n  Line one  \nLine two",
  });
  insertAgent({ id: "a-alpha", name: "Alpha", soul: "x".repeat(200) });
  insertAgent({ id: "a-old", name: "Old", status: "archived" });
  insertAgent({ id: "a-draft", name: "Drafted", status: "draft" });

  expect(await service.list(user)).toEqual([
    {
      avatar: { color: "slate", glyph: "?" },
      costThisWeekCents: 0,
      id: "a-alpha",
      isLead: false,
      jobLine: "x".repeat(140),
      learnedCount: 0,
      name: "Alpha",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-alpha",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
    {
      avatar: { color: "blue", glyph: "Z" },
      costThisWeekCents: 0,
      id: "a-zeta",
      isLead: false,
      jobLine: "Line one",
      learnedCount: 0,
      name: "Zeta",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-zeta",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
  ]);
});

test("an avatar column that is not JSON, or does not validate, falls back to the default avatar", async () => {
  insertAgent({ avatar: "not json", id: "a-bad-json", name: "Bree" });
  insertAgent({
    avatar: '{"color":"pink","glyph":"B"}',
    id: "a-bad-color",
    name: "Cass",
  });

  const cards = await service.list(user);
  expect(cards.map((card) => card.avatar)).toEqual([
    defaultAgentAvatar("Bree"),
    defaultAgentAvatar("Cass"),
  ]);
});

test("a valid avatar column comes back unchanged", async () => {
  insertAgent({
    avatar: '{"color":"teal","glyph":"★"}',
    id: "a-good",
    name: "Dana",
  });

  const [card] = await service.list(user);
  expect(card?.avatar).toEqual({ color: "teal", glyph: "★" });
});

test("another workspace's agents are not listed", async () => {
  insertAgent({ id: "a-mine", name: "Mine" });
  insertAgent({
    id: "a-theirs",
    name: "Theirs",
    workspaceId: OTHER_WORKSPACE,
  });

  expect((await service.list(user)).map((card) => card.id)).toEqual(["a-mine"]);
});

test("the system principal is refused", async () => {
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});
