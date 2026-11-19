import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ProposedTrigger } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { sql } from "drizzle-orm";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { Fetcher } from "../connectors/mcp.ts";
import { createJobsService } from "../jobs.ts";
import { NO_KEY_MESSAGE } from "../managed/keys.ts";
import type { Principal } from "../workspaces.ts";
import { createJobDrafter } from "./draft.ts";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};
let db: ReturnType<typeof migrated>;
beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org1",
      createdAt: "2026-11-20T00:00:00Z",
      id: "w1",
      name: "Support",
      timezone: "Australia/Sydney",
    })
    .run();
  db.insert(agents)
    .values({
      createdAt: "2026-11-20T00:00:00Z",
      createdBy: "u1",
      id: "a1",
      instructions: "Triage support tickets",
      model: "fake",
      name: "Support helper",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "support",
      status: "active",
      workspaceId: "w1",
    })
    .run();
});
const routine: ProposedTrigger = {
  asksBefore: null,
  cron: "0 9 * * 5",
  deliversTo: "Me",
  does: "Summarise support tickets",
  source: "routine",
  timezone: null,
  when: "Every Friday at 09:00",
};
const scriptedFetch = (replies: unknown[]) => {
  const calls: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fetcher: Fetcher = (url, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
      url: String(url),
    });
    const input = replies.shift();
    return Promise.resolve(
      Response.json({
        content: [{ input, name: "draft_job", type: "tool_use" }],
      })
    );
  };
  return { calls, fetcher };
};
const setup = (replies: unknown[], hasKey = true) => {
  const { calls, fetcher } = scriptedFetch(replies);
  const resolved: string[] = [];
  const drafter = createJobDrafter({
    db,
    fetch: fetcher,
    managedKeys: {
      resolve: (workspaceId) => {
        resolved.push(workspaceId);
        return Promise.resolve(
          hasKey ? { apiKey: "sk-test-private", environmentId: null } : null
        );
      },
    },
  });
  return { calls, resolved, service: createJobsService({ drafter }) };
};
const draft = (
  service: ReturnType<typeof createJobsService>,
  text = "Every Friday, summarise support tickets for me"
) => service.draft(user, "a1", text);

const cases = [
  {
    proposal: routine,
    text: "Every Friday, summarise support tickets for me",
  },
  {
    proposal: {
      ...routine,
      cron: "ignored",
      does: "Triage the mail",
      source: "mail",
      timezone: "ignored",
      when: "When support mail arrives",
    },
    text: "When a customer emails the support address, triage it",
  },
  {
    proposal: {
      ...routine,
      does: "Post a summary",
      source: "http",
      when: "When the billing webhook is called",
    },
    text: "Whenever our billing webhook is called, post a summary",
  },
] as const;
test.each(cases)(
  "$text drafts without any writes",
  async ({ text, proposal }) => {
    const { service, calls, resolved } = setup([proposal]);
    const before = db.get(sql`select total_changes() as changes`);
    expect(await draft(service, text)).toEqual({
      ...proposal,
      cron: proposal.source === "routine" ? proposal.cron : null,
      timezone: proposal.source === "routine" ? "Australia/Sydney" : null,
    });
    expect(db.get(sql`select total_changes() as changes`)).toEqual(before);
    expect(resolved).toEqual(["w1"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) {
      throw new Error("No model call recorded");
    }
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("sk-test-private");
    expect(call.body.model).toBe(CLOUD_DEFAULT_MODEL);
    expect(call.body.tools).toEqual([
      expect.objectContaining({
        input_schema: expect.objectContaining({ type: "object" }),
        name: "draft_job",
      }),
    ]);
    expect(call.body.tool_choice).toEqual({ type: "auto" });
    const message = JSON.stringify(call.body.messages);
    for (const context of [
      text,
      "Support helper",
      "Triage support tickets",
      "Australia/Sydney",
    ]) {
      expect(message).toContain(context);
    }
  }
);

test("no time or event asks the person for one without retrying", async () => {
  const { service, calls } = setup([{ needsWhen: true }]);
  await expect(
    draft(service, "Summarise support tickets")
  ).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("Say when it should run"),
  });
  expect(calls).toHaveLength(1);
});

test("no key refuses before calling the model", async () => {
  const { service, calls } = setup([], false);
  await expect(draft(service)).rejects.toMatchObject({
    code: "invalid",
    message: NO_KEY_MESSAGE,
  });
  expect(calls).toHaveLength(0);
});

test("invalid cron is retried once and rejected with a generic error", async () => {
  const invalid = { ...routine, cron: "99 9 * * 5" };
  const { service, calls } = setup([invalid, invalid]);
  const error = await draft(service, "PRIVATE person's text").catch(
    (caught: unknown) => caught
  );
  expect(error).toMatchObject({ code: "invalid" });
  expect(String(error)).not.toContain("PRIVATE");
  expect(String(error)).not.toContain("sk-test-private");
  expect(calls).toHaveLength(2);
});

test("a bad reply can recover on retry", async () => {
  const { service, calls } = setup([{}, routine]);
  expect((await draft(service)).cron).toBe(routine.cron);
  expect(calls).toHaveLength(2);
});

for (const timezone of ["Europe/London", "not/a-zone"]) {
  test(`routine timezone reconciles ${timezone}`, async () => {
    const { service } = setup([{ ...routine, timezone }]);
    expect((await draft(service)).timezone).toBe(
      timezone === "Europe/London" ? timezone : "Australia/Sydney"
    );
  });
}

test("an agent in another workspace is not found before any model call", async () => {
  const { service, calls } = setup([routine]);
  await expect(
    service.draft({ ...user, workspaceId: "other" }, "a1", "Every Friday")
  ).rejects.toMatchObject({
    code: "not_found",
  });
  expect(calls).toHaveLength(0);
});

test("explicit when I ask drafts an app job", async () => {
  const { service } = setup([
    {
      ...routine,
      cron: null,
      source: "app",
      timezone: null,
      when: "When I ask",
    },
  ]);
  expect(
    (await draft(service, "When I ask, summarise support tickets")).source
  ).toBe("app");
});

test("network errors are retried without exposing request text or credentials", async () => {
  let calls = 0;
  const drafter = createJobDrafter({
    db,
    fetch: () => {
      calls += 1;
      return Promise.reject(new Error("sk-test-private PRIVATE person's text"));
    },
    managedKeys: {
      resolve: () =>
        Promise.resolve({ apiKey: "sk-test-private", environmentId: null }),
    },
  });
  const error = await drafter
    .draft(user, "a1", "PRIVATE person's text")
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "invalid" });
  expect(String(error)).not.toContain("PRIVATE");
  expect(String(error)).not.toContain("sk-test-private");
  expect(calls).toBe(2);
});
