import { describe, expect, test } from "bun:test";
import type {
  AdminAgentInfo,
  AdminKeyCreated,
  AdminPort,
  AdminSecretInfo,
  McpPorts,
} from "../ports";
import { agentumTools, TOOL_NAMES } from "../server";
import { textOf } from "../testing";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const WRITE_NAMES = [
  "create_agent",
  "update_agent",
  "create_inbox_thread",
  "archive_agent",
  "restore_agent",
  "set_agent_owners",
  "set_agent_ask_before",
  "check_agent_address",
  "reserve_agent_address",
];
const SETUP_NAMES = [
  "create_secret",
  "grant_secret",
  "revoke_secret",
  "create_enrolment_code",
  "create_api_key",
  "revoke_api_key",
  "delete_connector",
];
const ADMIN_NAMES = [...WRITE_NAMES, ...SETUP_NAMES];

const SECRET_VALUE = "hm-test-secret-value-7f3a9c";

const AGENT: AdminAgentInfo = {
  id: "agent_1",
  model: "model-x",
  name: "Scout",
  runtime: "cloud",
  slug: "scout",
};

const SECRET: AdminSecretInfo = {
  hosts: ["api.example.com"],
  id: "secret_1",
  mode: "proxy",
  name: "EXAMPLE_TOKEN",
};

const KEY: AdminKeyCreated = {
  access: "read",
  id: "key_1",
  name: "ci",
  prefix: "hm_key_ab",
  secret: "hm_key_abcdef0123456789",
};

/** A port whose every method records its input and answers with a fixed value. */
const recordingAdmin = () => {
  const calls: Record<string, unknown[]> = {};
  const record =
    <T>(name: string, answer: T) =>
    (input?: unknown): Promise<T> => {
      calls[name] = [...(calls[name] ?? []), input];
      return Promise.resolve(answer);
    };
  const port: AdminPort = {
    createAgent: record("createAgent", AGENT),
    createApiKey: record("createApiKey", KEY),
    createEnrolmentCode: record("createEnrolmentCode", {
      code: "enrol-code-123",
      expiresAt: "2026-10-28T00:00:00Z",
    }),
    createInboxThread: record("createInboxThread", {
      createdAt: "2026-10-27T00:00:00Z",
      id: "thread_1",
      lastPostAt: "2026-10-27T00:00:00Z",
      title: "Plans",
    }),
    createSecret: record("createSecret", SECRET),
    deleteConnector: record("deleteConnector", undefined),
    grantSecret: record("grantSecret", undefined),
    revokeApiKey: record("revokeApiKey", {
      id: "key_1",
      name: "ci",
      revokedAt: "2026-10-27T00:00:00Z",
    }),
    revokeSecret: record("revokeSecret", undefined),
    updateAgent: record("updateAgent", AGENT),
  } as AdminPort;
  return { calls, port };
};

const portsWith = (admin: AdminPort): McpPorts => fakePorts({ admin });

const namesFor = (ports: McpPorts, options = {}): string[] =>
  agentumTools(ports, options)
    .map((tool) => tool.name)
    .filter((name) => ADMIN_NAMES.includes(name))
    .sort();

describe("admin tool registration", () => {
  const { port } = recordingAdmin();

  test("write access offers the management and inbox tools", () => {
    expect(namesFor(portsWith(port), { admin: "write" })).toEqual(
      [...WRITE_NAMES].sort()
    );
  });

  test("admin access offers management, inbox and setup tools", () => {
    expect(namesFor(portsWith(port), { admin: "admin" })).toEqual(
      [...ADMIN_NAMES].sort()
    );
  });

  test("no admin option offers none", () => {
    expect(namesFor(portsWith(port))).toEqual([]);
  });

  test("a read-only caller gets none, even with an admin option", () => {
    expect(
      namesFor(portsWith(port), { admin: "admin", readOnly: true })
    ).toEqual([]);
  });

  test("a caller without an admin port gets none", () => {
    expect(namesFor(fakePorts(), { admin: "admin" })).toEqual([]);
  });

  test("the default tool list leaves the admin tools out", () => {
    for (const name of ADMIN_NAMES) {
      expect(TOOL_NAMES).not.toContain(name);
    }
  });
});

describe("admin tools call their port with the input", () => {
  test("create_agent passes the input through", async () => {
    const { calls, port } = recordingAdmin();
    const args = {
      connectors: ["github"],
      environment: "linux-vm",
      instructions: "Be brief.",
      maxTurns: 5,
      model: "model-x",
      name: "Scout",
      networkAccess: true,
      runtime: "cloud",
      slug: "scout",
    };
    const result = await callTool(portsWith(port), "create_agent", args, {
      admin: "write",
    });
    expect(result.isError).toBeFalsy();
    expect(calls.createAgent).toEqual([args]);
    expect(textOf(result)).toContain("scout");
    expect(result.structuredContent).toEqual({ agent: AGENT });
  });

  test("update_agent passes a null machineId through", async () => {
    const { calls, port } = recordingAdmin();
    await callTool(
      portsWith(port),
      "update_agent",
      { agent: "scout", machineId: null, model: "model-y" },
      { admin: "write" }
    );
    expect(calls.updateAgent).toEqual([
      { agent: "scout", machineId: null, model: "model-y" },
    ]);
  });

  test("create_inbox_thread returns the thread id", async () => {
    const { calls, port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "create_inbox_thread",
      { title: "Plans" },
      { admin: "write" }
    );
    expect(calls.createInboxThread).toEqual([{ title: "Plans" }]);
    expect(textOf(result)).toContain("thread_1");
  });

  test("grant_secret and revoke_secret pass agent and secret id", async () => {
    const { calls, port } = recordingAdmin();
    const args = { agent: "scout", secretId: "secret_1" };
    await callTool(portsWith(port), "grant_secret", args, { admin: "admin" });
    await callTool(portsWith(port), "revoke_secret", args, { admin: "admin" });
    expect(calls.grantSecret).toEqual([args]);
    expect(calls.revokeSecret).toEqual([args]);
  });

  test("create_enrolment_code returns the code and says it is shown once", async () => {
    const { calls, port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "create_enrolment_code",
      { machineName: "box", role: "agent_host" },
      { admin: "admin" }
    );
    expect(calls.createEnrolmentCode).toEqual([
      { machineName: "box", role: "agent_host" },
    ]);
    expect(textOf(result)).toContain("enrol-code-123");
    expect(textOf(result)).toContain("shown once");
    expect(result.structuredContent).toEqual({
      code: "enrol-code-123",
      expiresAt: "2026-10-28T00:00:00Z",
    });
  });

  test("create_api_key returns the secret once and says so", async () => {
    const { calls, port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "create_api_key",
      { access: "read", name: "ci" },
      { admin: "admin" }
    );
    expect(calls.createApiKey).toEqual([{ access: "read", name: "ci" }]);
    expect(textOf(result)).toContain(KEY.secret);
    expect(textOf(result)).toContain("shown once");
    expect(result.structuredContent).toEqual({ key: KEY });
  });

  test("revoke_api_key passes the key id", async () => {
    const { calls, port } = recordingAdmin();
    await callTool(
      portsWith(port),
      "revoke_api_key",
      { keyId: "key_1" },
      { admin: "admin" }
    );
    expect(calls.revokeApiKey).toEqual([{ keyId: "key_1" }]);
  });

  test("delete_connector passes the connector id and is destructive", async () => {
    const { calls, port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "delete_connector",
      { connectorId: "conn_1" },
      { admin: "admin" }
    );
    expect(calls.deleteConnector).toEqual([{ connectorId: "conn_1" }]);
    expect(textOf(result)).toContain("conn_1");
    const tool = agentumTools(portsWith(port), { admin: "admin" }).find(
      (candidate) => candidate.name === "delete_connector"
    );
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});

describe("create_secret", () => {
  test("an env secret passes its allowed hosts and value", async () => {
    const { calls, port } = recordingAdmin();
    await callTool(
      portsWith(port),
      "create_secret",
      {
        allowedHosts: ["api.example.com"],
        mode: "env",
        name: "EXAMPLE_TOKEN",
        value: SECRET_VALUE,
      },
      { admin: "admin" }
    );
    expect(calls.createSecret).toEqual([
      {
        allowedHosts: ["api.example.com"],
        mode: "env",
        name: "EXAMPLE_TOKEN",
        value: SECRET_VALUE,
      },
    ]);
  });

  test("a proxy secret passes its rules and value", async () => {
    const { calls, port } = recordingAdmin();
    const rules = [
      {
        header: "Authorization",
        host: "api.example.com",
        template: "Bearer {value}",
      },
    ];
    await callTool(
      portsWith(port),
      "create_secret",
      { mode: "proxy", name: "EXAMPLE_TOKEN", rules, value: SECRET_VALUE },
      { admin: "admin" }
    );
    expect(calls.createSecret).toEqual([
      { mode: "proxy", name: "EXAMPLE_TOKEN", rules, value: SECRET_VALUE },
    ]);
  });

  test("an env secret with rules is refused before the port runs", async () => {
    const { calls, port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "create_secret",
      {
        mode: "env",
        name: "EXAMPLE_TOKEN",
        rules: [
          { header: "Authorization", host: "a.test", template: "{value}" },
        ],
        value: SECRET_VALUE,
      },
      { admin: "admin" }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("validation");
    expect(calls.createSecret).toBeUndefined();
  });

  test("a proxy secret without rules is refused before the port runs", async () => {
    const { calls, port } = recordingAdmin();
    const results = await Promise.all(
      [
        { mode: "proxy", name: "EXAMPLE_TOKEN", value: SECRET_VALUE },
        {
          mode: "proxy",
          name: "EXAMPLE_TOKEN",
          rules: [],
          value: SECRET_VALUE,
        },
      ].map((args) =>
        callTool(portsWith(port), "create_secret", args, { admin: "admin" })
      )
    );
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("validation");
    }
    expect(calls.createSecret).toBeUndefined();
  });

  test("the secret value appears in no result text or data", async () => {
    const { port } = recordingAdmin();
    const result = await callTool(
      portsWith(port),
      "create_secret",
      {
        mode: "proxy",
        name: "EXAMPLE_TOKEN",
        rules: [
          {
            header: "Authorization",
            host: "api.example.com",
            template: "Bearer {value}",
          },
        ],
        value: SECRET_VALUE,
      },
      { admin: "admin" }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("EXAMPLE_TOKEN");
    expect(textOf(result)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      SECRET_VALUE
    );
  });
});

const MANAGEMENT_WRITES = [
  "create_agent",
  "update_agent",
  "archive_agent",
  "restore_agent",
  "set_agent_owners",
  "set_agent_ask_before",
  "check_agent_address",
  "reserve_agent_address",
];

test("OAuth management access includes agent writes and excludes inbox and setup", () => {
  const { port } = recordingAdmin();
  const names = agentumTools(portsWith(port), { admin: "oauth-write" }).map(
    (tool) => tool.name
  );
  for (const name of [...MANAGEMENT_WRITES, "get_agent"]) {
    expect(names).toContain(name);
  }
  for (const name of [...SETUP_NAMES, "create_inbox_thread"]) {
    expect(names).not.toContain(name);
  }
});

test("callers without management access never see agent writes", () => {
  const { port } = recordingAdmin();
  for (const options of [
    {},
    { readOnly: true },
    { admin: "oauth-write" as const, readOnly: true },
  ]) {
    const names = agentumTools(portsWith(port), options).map(
      (tool) => tool.name
    );
    expect(names).toContain("get_agent");
    for (const name of MANAGEMENT_WRITES) {
      expect(names).not.toContain(name);
    }
  }
});
