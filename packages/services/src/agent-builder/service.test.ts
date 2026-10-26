import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../agents.ts";
import { ForbiddenError } from "../authz.ts";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { Fetcher } from "../connectors/mcp.ts";
import type { ConnectorSummary } from "../connectors.ts";
import { ServiceError } from "../errors.ts";
import type { MachineRecord } from "../machines.ts";
import { type ManagedKeyResolution, NO_KEY_MESSAGE } from "../managed/keys.ts";
import type { SkillRecord } from "../skills-store/records.ts";
import type { Principal } from "../workspaces.ts";
import type { AgentDraft } from "./draft.ts";
import { type AgentBuilderDeps, createAgentBuilderService } from "./service.ts";

const user: Principal = {
  kind: "user",
  userId: "user_1",
  via: "session",
  workspaceId: "ws_1",
};

const validDraft: AgentDraft = {
  does: "Sort the inbox",
  handsTo: [],
  library: [],
  name: "Inbox helper",
  rules: [],
  runsOn: { runtime: "cloud" },
  sampleInput: [],
  skills: [],
  startsOn: [],
  tools: [],
  voice: "brief",
};

interface ApiBody {
  messages: { content: string; role: string }[];
  model: string;
  system: string;
  tool_choice: { type: string };
  tools: { input_schema: { type?: string }; name: string }[];
}

interface Call {
  body: ApiBody;
  headers: Headers;
  url: string;
}

const replyWith = (input: unknown, status = 200): Response =>
  new Response(
    JSON.stringify({
      content: [{ input, name: "draft_agent_profile", type: "tool_use" }],
    }),
    { status }
  );

/** A fake fetch that records each call and answers with the scripted replies in order. */
const scriptedFetch = (replies: Response[]) => {
  const calls: Call[] = [];
  const fetcher: Fetcher = (input, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as ApiBody,
      headers: new Headers(init?.headers),
      url: String(input),
    });
    const next = replies.shift();
    return next
      ? Promise.resolve(next)
      : Promise.reject(new Error("fetch called more times than scripted"));
  };
  return { calls, fetcher };
};

/** Methods the catalog and drafting paths never call. */
const unused = (): Promise<never> => Promise.reject(new Error("unused"));

const unusedAgents = {
  activate: unused,
  createDraft: unused,
  discardDraft: unused,
  get: unused,
  reserveAddress: unused,
  suggestAddress: unused,
  update: unused,
};

const unusedConnectors = { assign: unused };
const unusedSkillsStore = { assign: unused };

const catalogFixtures = () => ({
  agents: {
    ...unusedAgents,
    list: async () => [
      {
        id: "agent_1",
        instructions: "Review the results",
        name: "Reviewer",
      } as AgentRecord,
    ],
  },
  connectors: {
    ...unusedConnectors,
    list: async () => [
      {
        id: "conn_mail",
        name: "Mail Connector",
        tools: [{ description: null, name: "read", readOnly: true }],
        url: "https://mail.example/mcp",
      } as ConnectorSummary,
    ],
  },
  machines: {
    list: async () => [
      {
        id: "laptop",
        name: "Laptop",
        roles: ["agent_host", "computer"],
        status: "online",
      } as MachineRecord,
      {
        id: "desk",
        name: "Desk",
        roles: ["agent_host"],
        status: "offline",
      } as MachineRecord,
      {
        id: "old",
        name: "Old",
        roles: ["agent_host"],
        status: "revoked",
      } as MachineRecord,
      {
        id: "kiosk",
        name: "Kiosk",
        roles: ["computer"],
        status: "online",
      } as MachineRecord,
    ],
  },
  skillsStore: {
    ...unusedSkillsStore,
    list: async () => [
      {
        id: "skill_people",
        name: "Summarize",
        ownerAgentId: null,
      } as SkillRecord,
      {
        id: "skill_agent",
        name: "Agent only",
        ownerAgentId: "agent_1",
      } as SkillRecord,
    ],
  },
});

const keyed = (apiKey: string): ManagedKeyResolution => ({
  apiKey,
  environmentId: null,
});

const buildDeps = (
  overrides: {
    fetch?: Fetcher;
    key?: ManagedKeyResolution | null;
    anthropicConfigured?: boolean;
    routerConfigured?: boolean;
    machines?: MachineRecord[];
  } = {}
): AgentBuilderDeps => {
  const base = catalogFixtures();
  const key =
    overrides.key === undefined ? keyed("sk-ant-test-key") : overrides.key;
  return {
    agents: base.agents,
    connectors: base.connectors,
    fetch: overrides.fetch ?? scriptedFetch([]).fetcher,
    libraryAccess: { setGrant: async () => undefined },
    machines: overrides.machines
      ? { list: async () => overrides.machines ?? [] }
      : base.machines,
    managedKeys: {
      resolve: async () => key,
      status: async () => ({
        configured: overrides.anthropicConfigured ?? true,
        hint: "sk-a",
        updatedAt: null,
      }),
    },
    modelKeys: {
      status: async () => ({
        configured: overrides.routerConfigured ?? false,
        hint: null,
        updatedAt: null,
      }),
    },
    routines: { create: unused },
    runs: { startRun: unused },
    skillsStore: base.skillsStore,
  };
};

describe("catalog", () => {
  test("lists usable machines, managed and cloud runtimes, and people-owned skills only", async () => {
    const service = createAgentBuilderService(buildDeps());
    const catalog = await service.catalog(user);

    expect(catalog.runtimes).toEqual(["machine", "managed", "cloud"]);
    expect(catalog.machines).toEqual([
      { id: "laptop", name: "Laptop", online: true },
      { id: "desk", name: "Desk", online: false },
    ]);
    expect(catalog.skills).toEqual([
      { description: "", id: "skill_people", name: "Summarize" },
    ]);
    expect(catalog.agents).toEqual([
      { does: "Review the results", id: "agent_1", name: "Reviewer" },
    ]);
    expect(catalog.connectors).toEqual([
      {
        description: "https://mail.example/mcp",
        id: "conn_mail",
        name: "Mail Connector",
        tools: [{ name: "read", readOnly: true }],
      },
    ]);
  });

  test("with no machines and no keys there are no runtimes", async () => {
    const service = createAgentBuilderService(
      buildDeps({
        anthropicConfigured: false,
        machines: [],
        routerConfigured: false,
      })
    );
    const catalog = await service.catalog(user);
    expect(catalog.runtimes).toEqual([]);
    expect(catalog.machines).toEqual([]);
  });
});

describe("catalog with a computer-only machine", () => {
  test("offers neither the machine nor the machine runtime", async () => {
    const service = createAgentBuilderService(
      buildDeps({
        anthropicConfigured: false,
        machines: [
          {
            id: "kiosk",
            name: "Kiosk",
            roles: ["computer"],
            status: "online",
          } as MachineRecord,
        ],
        routerConfigured: false,
      })
    );
    const catalog = await service.catalog(user);
    expect(catalog.machines).toEqual([]);
    expect(catalog.runtimes).toEqual([]);
  });
});

describe("draft", () => {
  test("posts one Messages call on the workspace key and reconciles the reply", async () => {
    const { calls, fetcher } = scriptedFetch([replyWith(validDraft)]);
    const service = createAgentBuilderService(
      buildDeps({ fetch: fetcher, key: keyed("sk-ant-workspace") })
    );

    const result = await service.draft(user, {
      description: "Sort my inbox each morning",
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) {
      throw new Error("no call recorded");
    }
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("sk-ant-workspace");
    expect(call.headers.get("anthropic-version")).toBeTruthy();
    expect(call.body.model).toBe(CLOUD_DEFAULT_MODEL);

    const tool = call.body.tools.find(
      (entry) => entry.name === "draft_agent_profile"
    );
    expect(tool?.input_schema.type).toBe("object");
    // The default model rejects a forced tool, so the prompt names it instead.
    expect(call.body.tool_choice).toEqual({ type: "auto" });
    expect(call.body.system).toContain("draft_agent_profile");

    const userMessage = call.body.messages[0]?.content;
    expect(userMessage).toContain("conn_mail");
    expect(userMessage).toContain("Mail Connector");
    expect(userMessage).toContain("Sort my inbox each morning");

    expect(result.draft).toEqual(validDraft);
    expect(result.gaps).toEqual([]);
    expect(result.didList).toContain("Named it Inbox helper");
  });

  test("a connector id the model invented becomes a tools gap and is removed", async () => {
    const { fetcher } = scriptedFetch([
      replyWith({ ...validDraft, tools: ["conn_mail", "conn_ghost"] }),
    ]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));

    const result = await service.draft(user, { description: "Read mail" });

    expect(result.draft.tools).toEqual(["conn_mail"]);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ field: "tools" })
    );
    expect(result.gaps.some((gap) => gap.question.includes("conn_ghost"))).toBe(
      true
    );
  });

  test("locked fields keep the person's value over the model's", async () => {
    const { fetcher } = scriptedFetch([
      replyWith({ ...validDraft, name: "Model name" }),
    ]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));

    const result = await service.draft(user, {
      description: "Sort my inbox",
      locked: { name: "Mine" },
    });

    expect(result.draft.name).toBe("Mine");
  });

  test("no workspace key throws NO_KEY_MESSAGE without calling the model", async () => {
    const { calls, fetcher } = scriptedFetch([replyWith(validDraft)]);
    const service = createAgentBuilderService(
      buildDeps({ fetch: fetcher, key: null })
    );

    const error = await service
      .draft(user, { description: "Sort my inbox" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid", message: NO_KEY_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  test("one bad reply is retried and a good second reply succeeds", async () => {
    const { calls, fetcher } = scriptedFetch([
      replyWith({}),
      replyWith(validDraft),
    ]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));

    const result = await service.draft(user, { description: "Sort my inbox" });

    expect(calls).toHaveLength(2);
    expect(result.draft).toEqual(validDraft);
  });

  test("a 500 reply is retried and a good second reply succeeds", async () => {
    const { calls, fetcher } = scriptedFetch([
      new Response("upstream failed", { status: 500 }),
      replyWith(validDraft),
    ]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));

    const result = await service.draft(user, { description: "Sort my inbox" });

    expect(calls).toHaveLength(2);
    expect(result.draft).toEqual(validDraft);
  });

  test("two bad replies throw an invalid ServiceError after exactly two calls", async () => {
    const { calls, fetcher } = scriptedFetch([
      replyWith({}),
      new Response("upstream failed", { status: 500 }),
    ]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));

    const error = await service
      .draft(user, { description: "Sort my inbox" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(calls).toHaveLength(2);
  });

  test("a description over 8000 characters is refused before any call, without echoing it", async () => {
    const { calls, fetcher } = scriptedFetch([replyWith(validDraft)]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));
    const description = `SECRET-${"a".repeat(8000)}`;

    const error = await service
      .draft(user, { description })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("SECRET-");
    expect(String((error as Error).message)).not.toContain("aaaaaaaaaa");
    expect(calls).toHaveLength(0);
  });

  test("the system principal is refused", async () => {
    const { calls, fetcher } = scriptedFetch([replyWith(validDraft)]);
    const service = createAgentBuilderService(buildDeps({ fetch: fetcher }));
    const system: Principal = { kind: "system" };

    await expect(
      service.draft(system, { description: "Sort my inbox" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0);
  });
});
