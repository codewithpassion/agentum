import { beforeEach, describe, expect, test } from "bun:test";
import { a2aOutbox, a2aPushConfigs, a2aTasks } from "@repo/db/schema/a2a";
import { eq } from "drizzle-orm";
import {
  decryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { A2aTaskError } from "./errors.ts";
import { PUSH_CONFIGS_PER_TASK } from "./push-configs.ts";
import {
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  OTHER_CONNECTION,
  peerOf,
  SECRETS_KEY,
  textMessage,
} from "./tasks-fixture.ts";

let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
});

const rejects = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused");
};

const HOOK = "https://hook.example.com/a";

const pushRows = async () =>
  await f.db.select().from(a2aOutbox).where(eq(a2aOutbox.kind, "push"));

const onlyConfigRow = async () => {
  const rows = await f.db.select().from(a2aPushConfigs);
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected exactly one push config row");
  }
  return row;
};

const runIdOf = async (taskId: string): Promise<string> => {
  const [row] = await f.db
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  if (!row?.runId) {
    throw new Error("The task has no run");
  }
  return row.runId;
};

const decryptWith = async (
  binding: SecretBinding,
  stored: string
): Promise<string> =>
  await decryptSecret(await importSecretsKey(SECRETS_KEY), binding, stored);

describe("push configs of an inbound task", () => {
  test("create, get, list and delete a config on the caller's own task", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    const created = await f.tasks.createPushConfig(peerOf(), {
      config: {
        authentication: { credentials: "cred-1", scheme: "Bearer" },
        id: "cfg-a",
        token: "tok-1",
        url: HOOK,
      },
      taskId: task.id,
    });
    expect(created).toEqual({
      authentication: { scheme: "Bearer" },
      id: "cfg-a",
      taskId: task.id,
      url: HOOK,
    });
    const plain = await f.tasks.createPushConfig(peerOf(), {
      config: { url: "https://hook.example.com/b" },
      taskId: task.id,
    });
    expect(plain).not.toHaveProperty("authentication");
    expect(plain.taskId).toBe(task.id);

    expect(
      await f.tasks.getPushConfig(peerOf(), { id: "cfg-a", taskId: task.id })
    ).toEqual(created);
    const listed = await f.tasks.listPushConfigs(peerOf(), {
      taskId: task.id,
    });
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([created, plain]));
    const views = JSON.stringify(listed);
    expect(views).not.toContain("cred-1");
    expect(views).not.toContain("tok-1");

    await f.tasks.deletePushConfig(peerOf(), { id: "cfg-a", taskId: task.id });
    await f.tasks.deletePushConfig(peerOf(), { id: "cfg-a", taskId: task.id });
    expect(
      (await f.tasks.listPushConfigs(peerOf(), { taskId: task.id })).map(
        (config) => config.id
      )
    ).toEqual([plain.id]);
  });

  test("the credentials and the token are encrypted at rest and bound to their row", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    await f.tasks.createPushConfig(peerOf(), {
      config: {
        authentication: { credentials: "cred-1", scheme: "Bearer" },
        token: "tok-1",
        url: HOOK,
      },
      taskId: task.id,
    });
    const row = await onlyConfigRow();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("cred-1");
    expect(stored).not.toContain("tok-1");
    expect(stored).not.toContain("Bearer");

    const authentication = await decryptWith(
      {
        field: "authentication",
        rowId: row.id,
        table: "a2a_push_configs",
        workspaceId: row.workspaceId,
      },
      row.authentication ?? ""
    );
    expect(JSON.parse(authentication)).toEqual({
      credentials: "cred-1",
      scheme: "Bearer",
    });
    const token = await decryptWith(
      {
        field: "token",
        rowId: row.id,
        table: "a2a_push_configs",
        workspaceId: row.workspaceId,
      },
      row.token ?? ""
    );
    expect(token).toBe("tok-1");

    const elsewhere = await rejects(
      decryptWith(
        {
          field: "authentication",
          rowId: "some-other-row",
          table: "a2a_push_configs",
          workspaceId: row.workspaceId,
        },
        row.authentication ?? ""
      )
    );
    expect(elsewhere).toBeInstanceOf(Error);
  });

  test("a task holds five configs, and a sixth is refused while another task still takes its own", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    for (let i = 0; i < PUSH_CONFIGS_PER_TASK; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each create checks the count the one before left
      await f.tasks.createPushConfig(peerOf(), {
        config: { url: `https://hook.example.com/${i}` },
        taskId: task.id,
      });
    }
    const sixth = await rejects(
      f.tasks.createPushConfig(peerOf(), {
        config: { url: "https://hook.example.com/6" },
        taskId: task.id,
      })
    );
    expect(sixth).toBeInstanceOf(ServiceError);
    expect((sixth as ServiceError).code).toBe("invalid");
    expect(
      await f.tasks.listPushConfigs(peerOf(), { taskId: task.id })
    ).toHaveLength(PUSH_CONFIGS_PER_TASK);

    const other = await f.tasks.sendMessage(peerOf(), textMessage("m2", "Hi"));
    const first = await f.tasks.createPushConfig(peerOf(), {
      config: { url: HOOK },
      taskId: other.id,
    });
    expect(first.taskId).toBe(other.id);
  });

  test("a URL the safe-URL guard refuses is refused and writes no row", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    const refusals = await Promise.all(
      [
        "http://hook.example.com/x",
        "https://127.0.0.1/x",
        "https://user:pw@example.com/x",
        "https://localhost/x",
      ].map((url) =>
        rejects(
          f.tasks.createPushConfig(peerOf(), {
            config: { url },
            taskId: task.id,
          })
        )
      )
    );
    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(ServiceError);
      expect((refused as ServiceError).code).toBe("invalid");
    }
    expect(await f.db.select().from(a2aPushConfigs)).toHaveLength(0);
  });

  test("a client-chosen id that repeats on the same task is a conflict", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    await f.tasks.createPushConfig(peerOf(), {
      config: { id: "cfg-a", url: HOOK },
      taskId: task.id,
    });
    const repeat = await rejects(
      f.tasks.createPushConfig(peerOf(), {
        config: { id: "cfg-a", url: "https://hook.example.com/b" },
        taskId: task.id,
      })
    );
    expect(repeat).toBeInstanceOf(ServiceError);
    expect((repeat as ServiceError).code).toBe("conflict");
    expect(
      await f.tasks.listPushConfigs(peerOf(), { taskId: task.id })
    ).toHaveLength(1);
  });

  test("a missing config, or another connection's task, reads as TaskNotFoundError", async () => {
    await f.connect();
    await f.connect({ id: OTHER_CONNECTION });
    const mine = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    const theirs = await f.tasks.sendMessage(
      peerOf(OTHER_CONNECTION),
      textMessage("m1", "Hi")
    );
    await f.tasks.createPushConfig(peerOf(OTHER_CONNECTION), {
      config: { id: "cfg-x", url: HOOK },
      taskId: theirs.id,
    });

    const missing = [
      await rejects(
        f.tasks.getPushConfig(peerOf(), { id: "nope", taskId: mine.id })
      ),
    ];
    for (const error of missing) {
      expect((error as A2aTaskError).errorName).toBe("TaskNotFoundError");
    }
    // Delete is idempotent (spec 3.1.10): a config that is gone deletes without an error.
    await f.tasks.deletePushConfig(peerOf(), { id: "nope", taskId: mine.id });

    const foreign = [
      await rejects(
        f.tasks.createPushConfig(peerOf(), {
          config: { url: HOOK },
          taskId: theirs.id,
        })
      ),
      await rejects(
        f.tasks.getPushConfig(peerOf(), { id: "cfg-x", taskId: theirs.id })
      ),
      await rejects(f.tasks.listPushConfigs(peerOf(), { taskId: theirs.id })),
      await rejects(
        f.tasks.deletePushConfig(peerOf(), { id: "cfg-x", taskId: theirs.id })
      ),
    ];
    for (const error of foreign) {
      expect((error as A2aTaskError).errorName).toBe("TaskNotFoundError");
    }
    expect(
      await f.tasks.listPushConfigs(peerOf(OTHER_CONNECTION), {
        taskId: theirs.id,
      })
    ).toHaveLength(1);
  });

  test("a webhook on localhost is refused unless the build is a dev build", async () => {
    await f.connect();
    const local = "http://localhost:9000/hook";
    const task = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    const refused = await rejects(
      f.tasks.createPushConfig(peerOf(), {
        config: { url: local },
        taskId: task.id,
      })
    );
    expect((refused as Error).message).toContain("not allowed");

    const dev = f.newTasks({ allowLoopback: true });
    const created = await dev.createPushConfig(peerOf(), {
      config: { url: local },
      taskId: task.id,
    });
    expect(created.url).toBe(local);
    // Dev opens this machine only. A private address stays refused.
    const privateUrl = await rejects(
      dev.createPushConfig(peerOf(), {
        config: { url: "http://10.0.0.5/hook" },
        taskId: task.id,
      })
    );
    expect((privateUrl as Error).message).toContain("not allowed");
  });

  test("a state change that queued pushes tells the app, and one with no config does not", async () => {
    let queued = 0;
    const tasks = f.newTasks({
      onPushQueued: () => {
        queued += 1;
      },
    });
    await f.connect({ inboundPolicy: "approve" });
    const bare = await tasks.sendMessage(
      peerOf(),
      textMessage("m1", "No hook")
    );
    await tasks.approveTask(member(), bare.id);
    expect(queued).toBe(0);

    const hooked = await tasks.sendMessage(peerOf(), textMessage("m2", "Hook"));
    await tasks.createPushConfig(peerOf(), {
      config: { url: HOOK },
      taskId: hooked.id,
    });
    await tasks.approveTask(member(), hooked.id);
    expect(queued).toBe(1);
    expect(await pushRows()).toHaveLength(1);
  });

  test("every state change queues one push per config, with the headers each config needs", async () => {
    await f.connect({ inboundPolicy: "approve" });
    const task = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m1", "Hello")
    );
    const withAuth = HOOK;
    const plain = "https://hook.example.com/b";
    await f.tasks.createPushConfig(peerOf(), {
      config: {
        authentication: { credentials: "cred-1", scheme: "Bearer" },
        token: "tok-1",
        url: withAuth,
      },
      taskId: task.id,
    });
    await f.tasks.createPushConfig(peerOf(), {
      config: { url: plain },
      taskId: task.id,
    });
    expect(await pushRows()).toHaveLength(0);

    await f.tasks.approveTask(member(), task.id);
    const approved = await pushRows();
    expect(approved).toHaveLength(2);
    const rowFor = (url: string) => {
      const row = approved.find((candidate) => candidate.url === url);
      if (!row) {
        throw new Error(`No push row for ${url}`);
      }
      return row;
    };
    for (const row of approved) {
      expect(row.kind).toBe("push");
      expect(row.connectionId).toBe(CONNECTION);
      expect(row.attempts).toBe(0);
      const body = JSON.parse(row.body) as {
        task: { id: string; status: { state: string } };
      };
      expect(body.task.id).toBe(task.id);
      expect(body.task.status.state).toBe("TASK_STATE_SUBMITTED");
    }

    const authRow = rowFor(withAuth);
    const headers = await decryptWith(
      {
        field: "headers",
        rowId: authRow.id,
        table: "a2a_outbox",
        workspaceId: authRow.workspaceId,
      },
      authRow.headers ?? ""
    );
    expect(JSON.parse(headers)).toEqual({
      Authorization: "Bearer cred-1",
      "X-A2A-Notification-Token": "tok-1",
    });
    expect(rowFor(plain).headers).toBeNull();

    const runId = await runIdOf(task.id);
    f.advance(1000);
    await f.runs.claimRun(f.system, runId);
    expect(await pushRows()).toHaveLength(4);

    f.advance(1000);
    await f.runs.completeRun(f.system, runId, { status: "done", text: "Done" });
    const all = await pushRows();
    expect(all).toHaveLength(6);
    for (const url of [withAuth, plain]) {
      const history = all
        .filter((row) => row.url === url)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      expect(
        history.map(
          (row) =>
            (JSON.parse(row.body) as { task: { status: { state: string } } })
              .task.status.state
        )
      ).toEqual([
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_COMPLETED",
      ]);
      const last = JSON.parse(history.at(-1)?.body ?? "{}") as {
        task: { artifacts?: unknown[] };
      };
      expect(last.task.artifacts).toHaveLength(1);
    }
  });

  test("no push is queued for a task with no configs, and none after the connection is revoked", async () => {
    await f.connect({ inboundPolicy: "approve" });
    const bare = await f.tasks.sendMessage(peerOf(), textMessage("m1", "Hi"));
    await f.tasks.approveTask(member(), bare.id);
    expect(await pushRows()).toHaveLength(0);

    const running = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m2", "Go")
    );
    await f.tasks.approveTask(member(), running.id);
    await f.tasks.createPushConfig(peerOf(), {
      config: { url: HOOK },
      taskId: running.id,
    });
    const waiting = await f.tasks.sendMessage(
      peerOf(),
      textMessage("m3", "Hi")
    );
    await f.tasks.createPushConfig(peerOf(), {
      config: { url: HOOK },
      taskId: waiting.id,
    });
    await f.connections.revoke(member(), CONNECTION);

    const states = await f.db
      .select({ id: a2aTasks.id, state: a2aTasks.state })
      .from(a2aTasks);
    expect(states.find((row) => row.id === running.id)?.state).toBe(
      "TASK_STATE_CANCELED"
    );
    expect(states.find((row) => row.id === waiting.id)?.state).toBe(
      "TASK_STATE_REJECTED"
    );
    expect(await pushRows()).toHaveLength(0);
  });

  test("a config sent with the message is registered on the new task", async () => {
    await f.connect();
    const task = await f.tasks.sendMessage(peerOf(), {
      ...textMessage("m1", "Hi"),
      configuration: {
        taskPushNotificationConfig: { token: "t", url: HOOK },
      },
    });
    const configs = await f.tasks.listPushConfigs(peerOf(), {
      taskId: task.id,
    });
    expect(configs.map((config) => config.url)).toEqual([HOOK]);
    expect(configs[0]?.taskId).toBe(task.id);
  });

  test("an invalid URL in the message refuses it and creates no task", async () => {
    await f.connect();
    const refused = await rejects(
      f.tasks.sendMessage(peerOf(), {
        ...textMessage("m1", "Hi"),
        configuration: {
          taskPushNotificationConfig: { url: "http://hook.example.com/a" },
        },
      })
    );
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("invalid");
    expect(await f.db.select().from(a2aTasks)).toHaveLength(0);
  });
});
