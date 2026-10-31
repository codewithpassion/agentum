import { beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { createPageReads, type PageReads } from "./page-reads.ts";
import {
  createFixture,
  type Fixture,
  member,
  OTHER_WORKSPACE,
  peerOf,
  textMessage,
  WORKSPACE,
} from "./tasks-fixture.ts";

const NOT_ALLOWED = /admin or the agent's owner/;

let f: Fixture;
let reads: PageReads;

beforeEach(async () => {
  f = await createFixture();
  reads = createPageReads({
    db: f.db,
    people: (ids) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [
            id,
            { email: `${id}@x.test`, name: `Name of ${id}` },
          ])
        )
      ),
  });
});

const rejects = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused");
};

describe("recentTasks", () => {
  test("lists a peer's task with who decided it and the run it started", async () => {
    const id = await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(id),
      textMessage("m1", "Please <b>summarise</b> the deploy")
    );
    await f.tasks.approveTask(member("u-decider"), task.id);

    const [row, ...rest] = await reads.recentTasks(member(), id);

    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      decidedBy: "Name of u-decider",
      direction: "in",
      id: task.id,
      text: "Please <b>summarise</b> the deploy",
    });
    expect(row?.runId).not.toBeNull();
  });

  test("a task nobody decided yet has no decider", async () => {
    const id = await f.connect();
    await f.tasks.sendMessage(peerOf(id), textMessage("m1", "Hello"));

    const [row] = await reads.recentTasks(member(), id);

    expect(row).toMatchObject({
      decidedBy: null,
      runId: null,
      state: "TASK_STATE_AUTH_REQUIRED",
    });
  });

  test("names a decider the lookup does not know as a member", async () => {
    const blind = createPageReads({
      db: f.db,
      people: () => Promise.resolve(new Map()),
    });
    const id = await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(id),
      textMessage("m1", "Hello")
    );
    await f.tasks.declineTask(member("u-decider"), task.id);

    const [row] = await blind.recentTasks(member(), id);

    expect(row?.decidedBy).toBe("A member");
  });

  test("another workspace cannot read the connection", async () => {
    const id = await f.connect();

    const error = await rejects(
      reads.recentTasks(member("u-bob", OTHER_WORKSPACE), id)
    );

    expect(error).toBeInstanceOf(ServiceError);
  });

  test("a run, a machine and a peer cannot read", async () => {
    const id = await f.connect();

    expect(
      await rejects(reads.recentTasks(peerOf(id) as Principal, id))
    ).toBeInstanceOf(ForbiddenError);
  });
});

describe("manage", () => {
  const session = (
    userId: string,
    isAdmin: boolean,
    via: "api_key" | "session" = "session"
  ): Principal => ({
    isAdmin,
    kind: "user",
    userId,
    via,
    workspaceId: WORKSPACE,
  });

  test("an admin and the agent's owner may change a connection", async () => {
    const id = await f.connect();

    expect(await reads.manage(session("u-admin", true), id)).toEqual({
      reason: null,
    });
    expect(await reads.manage(session("u-owner", false), id)).toEqual({
      reason: null,
    });
  });

  test("another member is told why not", async () => {
    const id = await f.connect();

    const { reason } = await reads.manage(session("u-member", false), id);

    expect(reason).toMatch(NOT_ALLOWED);
  });

  test("a key reader is told a session is needed", async () => {
    const id = await f.connect();

    const { reason } = await reads.manage(
      session("u-owner", true, "api_key"),
      id
    );

    expect(reason).toContain("signed in");
  });
});
