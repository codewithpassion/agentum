import { beforeEach, describe, expect, test } from "bun:test";
import { a2aTasks } from "@repo/db/schema/a2a";
import { runRequests } from "@repo/db/schema/requests";
import { eq } from "drizzle-orm";
import {
  AGENT,
  createFixture,
  type Fixture,
  member,
  peerOf,
  textMessage,
} from "./a2a/tasks-fixture.ts";

let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
});

/** A peer's task, its run claimed and running. */
const peerRun = async (): Promise<string> => {
  const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Go"));
  const [row] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, task.id));
  const runId = row?.runId;
  if (!runId) {
    throw new Error(`Task ${task.id} has no run`);
  }
  await f.runs.claimRun(f.system, runId);
  return runId;
};

const openApproval = (runId: string) =>
  f.requests.open(f.system, {
    input: { command: "ls" },
    kind: "approval",
    runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "t1",
  });

const status = async (requestId: string) =>
  (
    await f.db.select().from(runRequests).where(eq(runRequests.id, requestId))
  )[0]?.status;

describe("always allow on a peer's run", () => {
  test("is refused, the request stays pending, and no rule is written", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const approval = await openApproval(await peerRun());

    await expect(
      f.requests.answer(member(), {
        answer: { decision: "always_allow" },
        requestId: approval.id,
        via: "web",
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await status(approval.id)).toBe("pending");
    expect(
      await f.requests.listRules(member(), { agentId: AGENT })
    ).toHaveLength(0);
  });

  test("allow once still closes the request", async () => {
    await f.connect({ inboundPolicy: "auto" });
    const approval = await openApproval(await peerRun());

    await f.requests.answer(member(), {
      answer: { decision: "allow_once" },
      requestId: approval.id,
      via: "web",
    });
    expect(await status(approval.id)).toBe("answered");
  });
});
