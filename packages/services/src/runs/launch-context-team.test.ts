import { expect, test } from "bun:test";
import { agentLibraryAccess } from "@repo/db/schema/library";
import { teamMembers, teams } from "@repo/db/schema/teams";
import type { MemoryNote } from "@repo/db/shared";
import { findAgent } from "../agents.ts";
import { serializeMemoryFile } from "../memory/codec.ts";
import { commitFolderFiles } from "../memory/files.ts";
import { libraryMemoryReader } from "../memory/prompt.ts";
import { libraryTeamMemoryReader } from "../memory/team.ts";
import {
  AGENT,
  makeWorld,
  person,
  RUN,
  USER_A,
  WORKSPACE,
} from "../memory/test-world.ts";
import { buildLaunchContext } from "./launch-context.ts";
import { loadRun } from "./queries.ts";

const START = "2026-11-20T09:00:00.000Z";
const SLUG = "scout";

type World = ReturnType<typeof makeWorld>;

const note = (
  n: number,
  overrides: Partial<MemoryNote> & Pick<MemoryNote, "kind" | "text">
): MemoryNote => ({
  date: "2026-11-02",
  id: `01HZ7KQ3M8V2X4R6T9B1C5${String(n).padStart(4, "0")}`,
  source: null,
  userScope: null,
  writtenBy: "person",
  ...overrides,
});

const addTeam = (
  world: World,
  team: {
    archivedAt?: string;
    folderPath: string | null;
    id: string;
    name: string;
  }
) => {
  world.db
    .insert(teams)
    .values({
      archivedAt: team.archivedAt ?? null,
      createdAt: START,
      folderPath: team.folderPath,
      id: team.id,
      name: team.name,
      rules: "",
      slug: team.id,
      workspaceId: WORKSPACE,
    })
    .run();
};

/** Joins the agent to a team. A team with a folder gets the write grant that membership gives. */
const joinTeam = (
  world: World,
  team: { folderPath: string | null; id: string },
  isHome: boolean
) => {
  world.db
    .insert(teamMembers)
    .values({
      isHome,
      memberId: AGENT,
      memberKind: "agent",
      teamId: team.id,
      workspaceId: WORKSPACE,
    })
    .run();
  if (team.folderPath !== null) {
    world.db
      .insert(agentLibraryAccess)
      .values({
        agentId: AGENT,
        createdAt: START,
        mode: "write",
        path: team.folderPath,
        workspaceId: WORKSPACE,
      })
      .run();
  }
};

/** Writes a team's memory files through the memory service's commit helper, as a person. */
const writeTeamFiles = (
  world: World,
  folderPath: string,
  files: Record<string, string>
) =>
  commitFolderFiles({
    library: world.library,
    principal: person(USER_A),
    statements: () => [],
    writes: Object.entries(files).map(([path, text]) => ({
      path: `${folderPath}/memory/${path}`,
      text,
    })),
  });

const launch = async (world: World, runId: string = RUN.mail) => {
  const run = await loadRun(world.db, runId, WORKSPACE);
  const agent = await findAgent(world.db, {
    id: AGENT,
    workspaceId: WORKSPACE,
  });
  if (!(run && agent)) {
    throw new Error("fixture missing");
  }
  return await buildLaunchContext(world.db, run, agent, {
    readMemoryFile: libraryMemoryReader(world.library, run, SLUG),
    readTeamMemoryFile: libraryTeamMemoryReader(world.library, run),
  });
};

/** The team notes of a launch as names and note texts, in prompt order. */
const teamTexts = async (world: World, runId?: string) => {
  const context = await launch(world, runId);
  return (context.memory?.team ?? []).map((team) => ({
    name: team.teamName,
    texts: team.notes.map((item) => item.text),
  }));
};

test("a member agent gets its team's notes in memory.team", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/sales", id: "sales", name: "Sales" });
  joinTeam(world, { folderPath: "teams/sales", id: "sales" }, true);
  await writeTeamFiles(world, "teams/sales", {
    "work.md": serializeMemoryFile("work.md", [
      note(1, { kind: "work", text: "Quotes go out in EUR" }),
    ]),
  });

  expect(await teamTexts(world)).toEqual([
    { name: "Sales", texts: ["Quotes go out in EUR"] },
  ]);
});

test("an agent in no team gets no team notes", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/sales", id: "sales", name: "Sales" });
  await writeTeamFiles(world, "teams/sales", {
    "work.md": serializeMemoryFile("work.md", [
      note(1, { kind: "work", text: "Quotes go out in EUR" }),
    ]),
  });

  expect(await teamTexts(world)).toEqual([]);
});

test("the Everyone team, which has no folder, gives no team notes", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: null, id: "everyone", name: "Everyone" });
  joinTeam(world, { folderPath: null, id: "everyone" }, true);

  expect(await teamTexts(world)).toEqual([]);
});

test("the home team comes first, and a second team gets only the budget left", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/sales", id: "sales", name: "Sales" });
  addTeam(world, { folderPath: "teams/ops", id: "ops", name: "Ops" });
  joinTeam(world, { folderPath: "teams/ops", id: "ops" }, false);
  joinTeam(world, { folderPath: "teams/sales", id: "sales" }, true);
  // Five 500-character notes: newest first, the budget takes all but the oldest's 500.
  const salesWork = ["A", "B", "C", "D", "E"].map((letter, index) =>
    note(index + 1, {
      date: `2026-11-0${index + 1}`,
      kind: "work",
      text: letter.repeat(500),
    })
  );
  await writeTeamFiles(world, "teams/sales", {
    "corrections.md": serializeMemoryFile("corrections.md", [
      note(6, { kind: "corrections", text: "Quote in EUR" }),
    ]),
    "work.md": serializeMemoryFile("work.md", salesWork),
  });
  await writeTeamFiles(world, "teams/ops", {
    "work.md": serializeMemoryFile("work.md", [
      note(7, { date: "2026-11-01", kind: "work", text: "P".repeat(400) }),
      note(8, { date: "2026-11-03", kind: "work", text: "O".repeat(490) }),
    ]),
  });

  // Sales spends 2512 of the 3000 characters, so Ops has 488 left. Its newer
  // 490-character note does not fit and is skipped; its older 400 one does.
  expect(await teamTexts(world)).toEqual([
    {
      name: "Sales",
      texts: [
        "Quote in EUR",
        "E".repeat(500),
        "D".repeat(500),
        "C".repeat(500),
        "B".repeat(500),
        "A".repeat(500),
      ],
    },
    { name: "Ops", texts: ["P".repeat(400)] },
  ]);
});

test("an archived team is skipped", async () => {
  const world = makeWorld();
  addTeam(world, {
    archivedAt: START,
    folderPath: "teams/legacy",
    id: "legacy",
    name: "Legacy",
  });
  joinTeam(world, { folderPath: "teams/legacy", id: "legacy" }, true);
  await writeTeamFiles(world, "teams/legacy", {
    "work.md": serializeMemoryFile("work.md", [
      note(1, { kind: "work", text: "Old process" }),
    ]),
  });

  expect(await teamTexts(world)).toEqual([]);
});

test("a team file that does not parse is skipped and the team's other files still load", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/broken", id: "broken", name: "Broken" });
  joinTeam(world, { folderPath: "teams/broken", id: "broken" }, true);
  await writeTeamFiles(world, "teams/broken", {
    "corrections.md": serializeMemoryFile("corrections.md", [
      note(1, { kind: "corrections", text: "Tone check" }),
    ]),
    "work.md": "this is not a memory file\n",
  });

  expect(await teamTexts(world)).toEqual([
    { name: "Broken", texts: ["Tone check"] },
  ]);
});

test("a private note in a team folder never reaches the prompt", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/sales", id: "sales", name: "Sales" });
  joinTeam(world, { folderPath: "teams/sales", id: "sales" }, true);
  await writeTeamFiles(world, "teams/sales", {
    "private/user_a.md": serializeMemoryFile("private/user_a.md", [
      note(2, {
        kind: "people",
        text: "Only Ana sees this",
        userScope: "user_a",
      }),
    ]),
    "work.md": serializeMemoryFile("work.md", [
      note(1, { kind: "work", text: "Shared quote rule" }),
    ]),
  });

  const texts = (await teamTexts(world)).flatMap((team) => team.texts);
  expect(texts).toEqual(["Shared quote rule"]);
});

test("a stray private file in a team folder is never read", async () => {
  const world = makeWorld();
  addTeam(world, { folderPath: "teams/sales", id: "sales", name: "Sales" });
  joinTeam(world, { folderPath: "teams/sales", id: "sales" }, true);
  await writeTeamFiles(world, "teams/sales", {
    "private/user_a.md": serializeMemoryFile("private/user_a.md", [
      note(2, {
        kind: "people",
        text: "Only Ana sees this",
        userScope: "user_a",
      }),
    ]),
    "work.md": serializeMemoryFile("work.md", [
      note(1, { kind: "work", text: "Shared quote rule" }),
    ]),
  });
  // Writing the files touched their blobs too; only the launch's reads count.
  world.baseBlobs.touched.splice(0);

  await launch(world);

  expect(
    world.baseBlobs.touched.filter((key) => key.includes("/private/"))
  ).toEqual([]);
});
