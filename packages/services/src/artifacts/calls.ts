/**
 * Live tool calls from an artifact (phase 2, R2.5).
 *
 * A page or an app's server code calls a connector tool that a person approved
 * for the version. The call runs with the signed-in viewer's own credential,
 * the result passes the event scrubber and a size cap, and keys never leave the
 * server.
 *
 * Two layers, so a live link can enter later without reshaping the first:
 *
 * - `createToolRunner` runs one tool as one person. It trusts its caller to
 *   have decided that the call is allowed, and it still refuses a tool that
 *   the connector does not mark `readOnlyHint`. B.6 builds on it with
 *   `userId: granted_by` after its own call-time checks.
 * - `createArtifactCallsService.callTool` is the member entry. It checks that
 *   the viewer may open the artifact and that the tool is among the version's
 *   approved grants, then runs it as the viewer.
 *
 * `<serverKey>/<tool>` names a connector by the key a run gives it:
 * `connectorServerKeys` over the making agent's assigned connectors in
 * assignment order, or over the workspace's connectors in creation order for
 * an artifact a person made (`callableConnectors`).
 */

import type { Database } from "@repo/db";
import {
  approvedToolTargets,
  type ConnectorCallRow,
  callableConnectors,
  findArtifactAccess,
  findVersionStatus,
} from "@repo/db/artifact-calls";
import type {
  ArtifactsCallToolInput,
  ArtifactsCallToolOutput,
} from "@repo/protocol/artifacts";
import { connectorServerKeys } from "@repo/protocol/server-keys";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import {
  callMcpTool,
  type Fetcher,
  McpUnauthorizedError,
} from "../connectors/mcp.ts";
import type { CredentialsService, Resolution } from "../credentials.ts";
import { ServiceError } from "../errors.ts";
import type { Payload } from "../events/payload.ts";
import { redactToolPayload } from "../events/scrub.ts";
import type { Principal } from "../workspaces.ts";
import { canOpen } from "./policy.ts";

/** The most a scrubbed result may weigh, as UTF-8 JSON. Bigger results are refused, not cut. */
export const MAX_CALL_RESULT_BYTES = 256 * 1024;

/** Why a tool call was refused or failed. `AppHost` passes the code on to the app. */
export type ArtifactCallErrorCode =
  /** The call did not work: the connector was unreachable or answered with an error. */
  | "failed"
  /** The viewer has to connect the connector first. */
  | "needs_auth"
  /** The tool is not approved for this version, or is not read-only. */
  | "not_granted"
  /** The result is bigger than `MAX_CALL_RESULT_BYTES`. */
  | "too_large";

export class ArtifactCallError extends Error {
  override readonly name = "ArtifactCallError";
  readonly code: ArtifactCallErrorCode;

  constructor(
    code: ArtifactCallErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
  }
}

export const isArtifactCallError = (
  error: unknown
): error is ArtifactCallError => error instanceof ArtifactCallError;

const cachedToolsSchema = z.array(
  z.object({ name: z.string(), readOnly: z.boolean().default(false) })
);

const cachedTools = (json: string): z.infer<typeof cachedToolsSchema> => {
  try {
    const parsed = cachedToolsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

/** `xero/list_invoices` as server key and tool name, or null. */
const splitToolKey = (
  toolKey: string
): { serverKey: string; toolName: string } | null => {
  const slash = toolKey.indexOf("/");
  return slash > 0 && slash < toolKey.length - 1
    ? { serverKey: toolKey.slice(0, slash), toolName: toolKey.slice(slash + 1) }
    : null;
};

const notGranted = (): ArtifactCallError =>
  new ArtifactCallError(
    "not_granted",
    "That tool is not approved for this artifact."
  );

export interface ToolRunInput {
  /**
   * The agent whose connector list gives the server keys: the artifact's
   * maker, as a run builds its keys over its own agent's connectors. Null for
   * an artifact a person made.
   */
  agentId: string | null;
  arguments: Record<string, unknown>;
  /** `<serverKey>/<tool>`. */
  toolKey: string;
  /** Whose credential the call uses. */
  userId: string;
  workspaceId: string;
}

export interface ToolRunner {
  run: (input: ToolRunInput) => Promise<ArtifactsCallToolOutput>;
}

/** The connector and tool a granted key names, when the tool is read-only. */
const findReadOnlyTool = async (
  db: Database,
  input: Pick<ToolRunInput, "agentId" | "toolKey" | "workspaceId">
): Promise<{
  connector: ConnectorCallRow;
  toolName: string;
}> => {
  const parts = splitToolKey(input.toolKey);
  if (!parts) {
    throw notGranted();
  }
  const rows = await callableConnectors(db, {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });
  const keys = connectorServerKeys(rows.map(({ name }) => name));
  const connector = rows[keys.indexOf(parts.serverKey)];
  if (!connector) {
    throw notGranted();
  }
  const tool = cachedTools(connector.tools).find(
    ({ name }) => name === parts.toolName
  );
  if (!tool?.readOnly) {
    throw notGranted();
  }
  return { connector, toolName: parts.toolName };
};

/** A refusal by the connector means the viewer must connect again, anything else is a failed call. */
const toCallError = (
  error: unknown,
  connectorName: string
): ArtifactCallError =>
  error instanceof McpUnauthorizedError
    ? new ArtifactCallError(
        "needs_auth",
        `Connect ${connectorName} again to use this artifact.`,
        { cause: error }
      )
    : new ArtifactCallError(
        "failed",
        `${connectorName} could not complete the call.`,
        { cause: error }
      );

/** The scrubbed result, or `too_large`. */
const scrubbed = (raw: Record<string, unknown>): ArtifactsCallToolOutput => {
  // The scrubber works on records of JSON, which a parsed MCP result is.
  const { result } = redactToolPayload({ result: raw } as Payload);
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > MAX_CALL_RESULT_BYTES) {
    throw new ArtifactCallError(
      "too_large",
      `The result is larger than ${MAX_CALL_RESULT_BYTES / 1024} KB.`
    );
  }
  return { result };
};

export const createToolRunner = ({
  callTool = callMcpTool,
  credentials,
  db,
  fetch: fetchImpl,
}: {
  /** The MCP `tools/call` client, replaceable in tests. */
  callTool?: typeof callMcpTool;
  credentials: Pick<CredentialsService, "refresh" | "resolveUser">;
  db: Database;
  fetch?: Fetcher;
}): ToolRunner => {
  const attempt = (
    resolution: Extract<Resolution, { ok: true }>,
    header: { name: string; value: string } | undefined,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> =>
    callTool(
      resolution.connector.url,
      {
        fetchImpl,
        header,
        timeoutMs: resolution.connector.callTimeoutSeconds * 1000,
      },
      { arguments: args, name: toolName }
    );

  /**
   * One try, and when the connector refuses the login, one refresh and a
   * second try, as the connector proxy does.
   */
  const send = async (
    resolution: Extract<Resolution, { ok: true }>,
    input: ToolRunInput,
    connectorName: string,
    toolName: string
  ): Promise<Record<string, unknown>> => {
    try {
      return await attempt(
        resolution,
        resolution.credential?.header,
        toolName,
        input.arguments
      );
    } catch (error) {
      if (!(error instanceof McpUnauthorizedError && resolution.credential)) {
        throw toCallError(error, connectorName);
      }
      const refreshed = await credentials.refresh({
        credentialId: resolution.credential.id,
        seenVersion: resolution.credential.version,
        workspaceId: input.workspaceId,
      });
      if (!refreshed.ok) {
        throw refreshed.reason === "retry"
          ? new ArtifactCallError("failed", "Try again in a moment.")
          : toCallError(error, connectorName);
      }
      return await attempt(
        resolution,
        refreshed.credential.header,
        toolName,
        input.arguments
      ).catch((second: unknown) => {
        throw toCallError(second, connectorName);
      });
    }
  };

  const run = async (input: ToolRunInput): Promise<ArtifactsCallToolOutput> => {
    const { connector, toolName } = await findReadOnlyTool(db, input);
    const resolution = await credentials.resolveUser({
      connectorId: connector.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    if (!resolution.ok) {
      if (resolution.reason === "needs_auth") {
        throw new ArtifactCallError(
          "needs_auth",
          `Connect ${connector.name} to use this artifact.`
        );
      }
      throw resolution.reason === "not_assigned"
        ? notGranted()
        : new ArtifactCallError("failed", "Try again in a moment.");
    }
    return scrubbed(await send(resolution, input, connector.name, toolName));
  };
  return { run };
};

/** What `AppHost` calls for a member's granted tool calls. */
export interface ArtifactToolPort {
  callTool: (
    principal: Principal,
    input: ArtifactsCallToolInput
  ) => Promise<ArtifactsCallToolOutput>;
}

export const createArtifactCallsService = ({
  db,
  runner,
}: {
  db: Database;
  runner: ToolRunner;
}): ArtifactToolPort => ({
  callTool: async (principal, input) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("call an artifact tool");
    }
    const { workspaceId, userId } = principal;
    authorize(principal, "artifact.call_tool", {
      id: input.artifactId,
      kind: "artifact",
      workspaceId,
    });
    const artifact = await findArtifactAccess(db, {
      artifactId: input.artifactId,
      workspaceId,
    });
    if (
      !(
        artifact &&
        canOpen(artifact, { isAdmin: principal.isAdmin === true, userId })
      )
    ) {
      throw new ServiceError("not_found", "Artifact not found.");
    }
    const status = await findVersionStatus(db, {
      artifactId: input.artifactId,
      versionId: input.versionId,
      workspaceId,
    });
    if (status !== "published") {
      throw new ServiceError("not_found", "Version not found.");
    }
    const granted = await approvedToolTargets(db, {
      versionId: input.versionId,
      workspaceId,
    });
    if (!granted.includes(input.tool)) {
      throw notGranted();
    }
    return await runner.run({
      agentId: artifact.agentId,
      arguments: input.arguments ?? {},
      toolKey: input.tool,
      userId,
      workspaceId,
    });
  },
});
