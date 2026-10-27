import { describe, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { type callMcpTool, McpUnauthorizedError } from "../connectors/mcp.ts";
import type {
  CredentialsService,
  Refreshed,
  Resolution,
} from "../credentials.ts";
import type { Principal } from "../workspaces.ts";
import {
  type ArtifactCallErrorCode,
  createArtifactCallsService,
  createToolRunner,
  isArtifactCallError,
  MAX_CALL_RESULT_BYTES,
} from "./calls.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const TOOLS = JSON.stringify([
  { description: null, name: "list_invoices", readOnly: true },
  { description: null, name: "create_bill", readOnly: false },
  { description: null, name: "unlisted_read", readOnly: true },
]);

const member = (userId: string, extra: Partial<Principal> = {}): Principal =>
  ({
    kind: "user",
    userId,
    via: "session",
    workspaceId: "w1",
    ...extra,
  }) as Principal;

interface Seen {
  args: Record<string, unknown>;
  header: { name: string; value: string } | undefined;
  name: string;
  url: string;
}

const setup = (
  options: {
    grants?: string[];
    result?: Record<string, unknown>;
    resolve?: (userId: string) => Resolution;
    throws?: unknown;
    /** The first connector call is refused with a 401, the retry works. */
    unauthorizedOnce?: boolean;
    refresh?: Refreshed;
  } = {}
) => {
  const db = migrated();
  db.insert(workspaces)
    .values([
      {
        clerkOrgId: "org_1",
        createdAt: NOW,
        id: "w1",
        name: "w1",
        timezone: "UTC",
      },
      {
        clerkOrgId: "org_2",
        createdAt: NOW,
        id: "w2",
        name: "w2",
        timezone: "UTC",
      },
    ])
    .run();
  db.insert(artifacts)
    .values({
      audience: "workspace",
      createdAt: NOW,
      createdById: "owner",
      createdByKind: "user",
      id: "ar1",
      kind: "app",
      ownerUserId: "owner",
      title: "Dash",
      updatedAt: NOW,
      workspaceId: "w1",
    })
    .run();
  db.insert(artifactVersions)
    .values(
      ["v1", "v2"].map((id, index) => ({
        artifactId: "ar1",
        authorId: "owner",
        authorKind: "user" as const,
        createdAt: NOW,
        entry: "index.html",
        fileCount: 1,
        id,
        manifestKey: `w1/artifact-manifests/${id}.json`,
        message: "m",
        number: index + 1,
        status: id === "v1" ? ("published" as const) : ("proposed" as const),
        totalBytes: 1,
        workspaceId: "w1",
      }))
    )
    .run();
  db.insert(connectors)
    .values({
      authKind: "header",
      createdAt: NOW,
      createdBy: "owner",
      id: "c1",
      name: "Xero",
      status: "ok",
      tools: TOOLS,
      url: "https://mcp.example.com/mcp",
      workspaceId: "w1",
    })
    .run();
  const targets = options.grants ?? ["xero/list_invoices"];
  db.insert(artifactGrants)
    .values(
      targets.map((target, index) => ({
        createdAt: NOW,
        id: `g${index}`,
        kind: "tool" as const,
        status: "approved" as const,
        target,
        versionId: "v1",
        workspaceId: "w1",
      }))
    )
    .run();
  db.insert(artifactGrants)
    .values({
      createdAt: NOW,
      id: "gp",
      kind: "tool",
      status: "pending",
      target: "xero/unlisted_read",
      versionId: "v1",
      workspaceId: "w1",
    })
    .run();

  const seen: Seen[] = [];
  const unauthorized: number[] = [];
  const resolveUserCalls: string[] = [];
  const refreshCalls: number[] = [];
  const credentials: Pick<CredentialsService, "refresh" | "resolveUser"> = {
    refresh: () => {
      refreshCalls.push(1);
      return Promise.resolve(
        options.refresh ?? {
          credential: {
            expiresAt: null,
            header: { name: "Authorization", value: "Bearer fresh" },
            id: "cred",
            ownerId: "x",
            ownerKind: "user",
            version: 2,
          },
          ok: true,
        }
      );
    },
    resolveUser: (input) => {
      resolveUserCalls.push(input.userId);
      return Promise.resolve(
        options.resolve
          ? options.resolve(input.userId)
          : {
              allowedTools: null,
              connector: {
                callTimeoutSeconds: 30,
                id: input.connectorId,
                name: "Xero",
                url:
                  input.connectorId === "c2"
                    ? "https://b.example.com/mcp"
                    : "https://mcp.example.com/mcp",
              },
              credential: {
                expiresAt: null,
                header: {
                  name: "Authorization",
                  value: `Bearer token-of-${input.userId}`,
                },
                id: "cred",
                ownerId: input.userId,
                ownerKind: "user",
                version: 1,
              },
              note: null,
              ok: true,
              ownerKind: "user",
              version: 1,
            }
      );
    },
  };
  const callTool: typeof callMcpTool = (url, clientOptions, toolCall) => {
    if (options.throws) {
      return Promise.reject(options.throws);
    }
    if (options.unauthorizedOnce && seen.length === unauthorized.length) {
      unauthorized.push(1);
      return Promise.reject(new McpUnauthorizedError(null));
    }
    seen.push({
      args: toolCall.arguments,
      header: clientOptions.header,
      name: toolCall.name,
      url,
    });
    return Promise.resolve(
      options.result ?? { content: [{ text: "3 invoices", type: "text" }] }
    );
  };
  const runner = createToolRunner({ callTool, credentials, db });
  return {
    db,
    refreshCalls,
    resolveUserCalls,
    seen,
    service: createArtifactCallsService({ db, runner }),
  };
};

const call = (tool: string, versionId = "v1") => ({
  arguments: { limit: 5 },
  artifactId: "ar1",
  tool,
  versionId,
});

const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return isArtifactCallError(error) ? error.code : (error as Error).message;
  }
  return "ok";
};

describe("callTool as a member (R2.5)", () => {
  test("a granted read-only tool runs with the viewer's own credential", async () => {
    const { resolveUserCalls, seen, service } = setup();
    const out = await service.callTool(
      member("viewer_a"),
      call("xero/list_invoices")
    );
    expect(out).toEqual({
      result: { content: [{ text: "3 invoices", type: "text" }] },
    });
    expect(resolveUserCalls).toEqual(["viewer_a"]);
    expect(seen).toEqual([
      {
        args: { limit: 5 },
        header: { name: "Authorization", value: "Bearer token-of-viewer_a" },
        name: "list_invoices",
        url: "https://mcp.example.com/mcp",
      },
    ]);
  });

  test("another viewer gets their own credential, never the first one's", async () => {
    const { seen, service } = setup();
    await service.callTool(member("viewer_a"), call("xero/list_invoices"));
    await service.callTool(member("viewer_b"), call("xero/list_invoices"));
    expect(seen.map((s) => s.header?.value)).toEqual([
      "Bearer token-of-viewer_a",
      "Bearer token-of-viewer_b",
    ]);
  });

  test("a tool that was not granted is refused before any credential is read", async () => {
    const { resolveUserCalls, seen, service } = setup();
    expect(
      await codeOf(service.callTool(member("v"), call("xero/other")))
    ).toBe("not_granted");
    expect(resolveUserCalls).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a pending grant is not a grant", async () => {
    const { seen, service } = setup();
    expect(
      await codeOf(service.callTool(member("v"), call("xero/unlisted_read")))
    ).toBe("not_granted");
    expect(seen).toEqual([]);
  });

  test("a granted tool that is not read-only is refused", async () => {
    const { seen, service } = setup({ grants: ["xero/create_bill"] });
    expect(
      await codeOf(service.callTool(member("v"), call("xero/create_bill")))
    ).toBe("not_granted");
    expect(seen).toEqual([]);
  });

  test("a granted tool the connector no longer lists is refused", async () => {
    const { service } = setup({ grants: ["xero/gone"] });
    expect(await codeOf(service.callTool(member("v"), call("xero/gone")))).toBe(
      "not_granted"
    );
  });

  test("grants belong to a version: a proposed version cannot be called", async () => {
    const { service } = setup();
    expect(
      await codeOf(
        service.callTool(member("v"), call("xero/list_invoices", "v2"))
      )
    ).toBe("Version not found.");
  });

  test("a viewer who has not connected gets needs_auth", async () => {
    const { seen, service } = setup({
      resolve: () => ({
        cause: "missing",
        connectPath: "/connect/c1?as=user",
        ok: false,
        ownerId: "v",
        ownerKind: "user",
        reason: "needs_auth",
      }),
    });
    expect(
      await codeOf(service.callTool(member("v"), call("xero/list_invoices")))
    ).toBe("needs_auth");
    expect(seen).toEqual([]);
  });

  test("a connector that refuses the credential gives needs_auth, other failures give failed", async () => {
    const refused = setup({ throws: new McpUnauthorizedError(null) });
    expect(
      await codeOf(
        refused.service.callTool(member("v"), call("xero/list_invoices"))
      )
    ).toBe("needs_auth");
    const broken = setup({
      throws: new Error("socket hang up with secret sk-abcdefghijklmnop1234"),
    });
    const error = await broken.service
      .callTool(member("v"), call("xero/list_invoices"))
      .catch((e: unknown) => e);
    expect(isArtifactCallError(error) && error.code).toBe("failed");
    expect((error as Error).message).not.toContain("sk-");
  });

  test("results are scrubbed", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const { service } = setup({
      result: {
        content: [
          {
            text: `key ${secret} and authorization: Bearer abcDEF123456789`,
            type: "text",
          },
        ],
      },
    });
    const out = await service.callTool(member("v"), call("xero/list_invoices"));
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain("abcDEF123456789");
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  test("an oversized result is refused, not cut", async () => {
    const { service } = setup({
      result: {
        content: [
          { text: "x".repeat(MAX_CALL_RESULT_BYTES + 1), type: "text" },
        ],
      },
    });
    const code: ArtifactCallErrorCode | unknown = await codeOf(
      service.callTool(member("v"), call("xero/list_invoices"))
    );
    expect(code).toBe("too_large");
  });

  test("another workspace's artifact is not found", async () => {
    const { service } = setup();
    expect(
      await codeOf(
        service.callTool(
          { ...member("v"), workspaceId: "w2" } as Principal,
          call("xero/list_invoices")
        )
      )
    ).toBe("Artifact not found.");
  });

  test("a private artifact is closed to other members and open to an admin", async () => {
    const { db, service } = setup();
    db.update(artifacts).set({ audience: "private" }).run();
    expect(
      await codeOf(service.callTool(member("v"), call("xero/list_invoices")))
    ).toBe("Artifact not found.");
    expect(
      await codeOf(
        service.callTool(
          member("boss", { isAdmin: true } as Partial<Principal>),
          call("xero/list_invoices")
        )
      )
    ).toBe("ok");
    expect(
      await codeOf(
        service.callTool(member("owner"), call("xero/list_invoices"))
      )
    ).toBe("ok");
  });

  test("only a person calls: a run principal is forbidden", async () => {
    const { service } = setup();
    const run: Principal = {
      agentId: "a",
      kind: "run",
      runId: "r",
      workspaceId: "w1",
    };
    expect(
      await codeOf(service.callTool(run, call("xero/list_invoices")))
    ).toBe("Not allowed: call an artifact tool");
  });

  test("a refused login is refreshed once and the call retried", async () => {
    const { refreshCalls, seen, service } = setup({ unauthorizedOnce: true });
    const out = await service.callTool(member("v"), call("xero/list_invoices"));
    expect(out.result).toBeDefined();
    expect(refreshCalls).toHaveLength(1);
    expect(seen.map((s) => s.header?.value)).toEqual(["Bearer fresh"]);
  });

  test("a login that cannot be refreshed gives needs_auth", async () => {
    const { service } = setup({
      refresh: {
        cause: "needs_auth",
        connectPath: "/connect/c1?as=user",
        ok: false,
        ownerId: "v",
        ownerKind: "user",
        reason: "needs_auth",
      },
      unauthorizedOnce: true,
    });
    expect(
      await codeOf(service.callTool(member("v"), call("xero/list_invoices")))
    ).toBe("needs_auth");
  });

  test("a malformed tool list in the connector row refuses instead of crashing", async () => {
    const { db, service } = setup();
    db.update(connectors).set({ tools: "{nope" }).run();
    expect(
      await codeOf(service.callTool(member("v"), call("xero/list_invoices")))
    ).toBe("not_granted");
  });

  test("server keys follow the making agent's connectors, so same-named connectors do not swap", async () => {
    const { db, seen, service } = setup();
    db.insert(connectors)
      .values({
        authKind: "header",
        createdAt: "2026-10-28T00:00:00.000Z",
        createdBy: "owner",
        id: "c2",
        name: "Xero",
        status: "ok",
        tools: TOOLS,
        url: "https://b.example.com/mcp",
        workspaceId: "w1",
      })
      .run();
    db.insert(agents)
      .values({
        createdAt: NOW,
        createdBy: "owner",
        id: "ag1",
        instructions: "",
        model: "m",
        name: "A",
        runtime: "fake",
        runtimeConfig: "{}",
        slug: "a",
        status: "active",
        workspaceId: "w1",
      })
      .run();
    db.insert(agentConnectors)
      .values({
        agentId: "ag1",
        connectorId: "c2",
        createdAt: NOW,
        workspaceId: "w1",
      })
      .run();
    // Made by a person: the first Xero in the workspace.
    await service.callTool(member("v"), call("xero/list_invoices"));
    // Made by the agent that was assigned only the second Xero.
    db.update(artifacts).set({ agentId: "ag1" }).run();
    await service.callTool(member("v"), call("xero/list_invoices"));
    expect(seen.map((s) => s.url)).toEqual([
      "https://mcp.example.com/mcp",
      "https://b.example.com/mcp",
    ]);
  });
});
