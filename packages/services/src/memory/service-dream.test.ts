import { expect, test } from "bun:test";
import { memoryChanges } from "@repo/db/schema/memory";
import { eq } from "drizzle-orm";
import { ServiceError } from "../errors.ts";
import { AGENT, makeWorld, person, USER_A, WORKSPACE } from "./test-world.ts";

const DREAM_RUN = "dream_run_1";
const DREAM_MESSAGE =
  "A change a dream made is decided and undone with its dream";

const seedDreamChange = (
  db: ReturnType<typeof makeWorld>["db"],
  id: string,
  status: "held" | "applied"
) =>
  db
    .insert(memoryChanges)
    .values({
      action: "add",
      agentId: AGENT,
      createdAt: new Date(Date.parse("2026-11-20T09:00:00.000Z")).toISOString(),
      dreamRunId: DREAM_RUN,
      id,
      kind: "people",
      noteId: `note_${id}`,
      status,
      text: "Mia prefers Google Docs",
      workspaceId: WORKSPACE,
      writtenBy: "dream",
    })
    .run();

const rowOf = (db: ReturnType<typeof makeWorld>["db"], id: string) =>
  db.select().from(memoryChanges).where(eq(memoryChanges.id, id)).get();

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

test("decide refuses a held change a dream made, approve or reject, and leaves it held", async () => {
  const world = makeWorld();
  seedDreamChange(world.db, "chg_dream_held", "held");
  const before = rowOf(world.db, "chg_dream_held");

  const errors = await Promise.all(
    (["approve", "reject"] as const).map((decision) =>
      rejectionOf(
        world.service.decide(person(USER_A), {
          changeId: "chg_dream_held",
          decision,
        })
      )
    )
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid", message: DREAM_MESSAGE });
  }
  expect(rowOf(world.db, "chg_dream_held")).toEqual(before);
});

test("undo refuses an applied change a dream made and leaves it applied", async () => {
  const world = makeWorld();
  seedDreamChange(world.db, "chg_dream_applied", "applied");
  const before = rowOf(world.db, "chg_dream_applied");

  const error = await rejectionOf(
    world.service.undo(person(USER_A), "chg_dream_applied")
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "invalid", message: DREAM_MESSAGE });
  expect(rowOf(world.db, "chg_dream_applied")).toEqual(before);
});
