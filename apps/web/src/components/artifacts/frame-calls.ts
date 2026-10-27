// Phase 2 handlers for the frame bridge: tools, app storage and messages.
// No DOM and no React in here. The page is untrusted, so no server text may
// reach it: every failure leaves as a `BridgeError` with a fixed message.

import {
  type ArtifactStorageScope,
  type StorageGetResult,
  type StorageListResult,
  type StorageSetRequest,
  shareCallResponseSchema,
  type ToolsCallResult,
} from "@repo/protocol/artifacts";
import {
  BRIDGE_ERROR,
  BridgeError,
  type BridgeHandlers,
} from "./frame-bridge.ts";

const MAX_MESSAGE_CHARS = 8000;

/** What `storage/set` carries: any JSON value. */
type StorageSetValue = StorageSetRequest["params"]["value"];

export interface CallToolInput {
  arguments?: Record<string, unknown>;
  tool: string;
}

/** The signed-in member, bound to one artifact and version by the caller. */
export interface MemberCalls {
  callTool: (input: CallToolInput) => Promise<{ result?: unknown }>;
  storageDelete: (input: {
    key: string;
    scope: ArtifactStorageScope;
  }) => Promise<unknown>;
  storageGet: (input: {
    key: string;
    scope: ArtifactStorageScope;
  }) => Promise<StorageGetResult>;
  storageList: (input: {
    prefix?: string;
    scope: ArtifactStorageScope;
  }) => Promise<StorageListResult>;
  storageSet: (input: {
    key: string;
    scope: ArtifactStorageScope;
    value: StorageSetValue;
  }) => Promise<unknown>;
}

/** A share link holder: tools, and reads of the shared storage area. */
export interface LinkCalls {
  callTool: (input: CallToolInput) => Promise<{ result?: unknown }>;
  storageGet: (input: { key: string }) => Promise<StorageGetResult>;
  storageList: (input: { prefix?: string }) => Promise<StorageListResult>;
}

export type FrameCalls =
  | ({ viewer: "member" } & MemberCalls)
  | ({ viewer: "link" } & LinkCalls);

/** A failed share-link call. `status` 0 means the network failed. */
export class LinkCallError extends Error {
  readonly status: number;
  constructor(status: number, options?: { cause?: unknown }) {
    super(`Link call failed with status ${status}`, options);
    this.status = status;
  }
}

const denied = (message: string) =>
  new BridgeError(BRIDGE_ERROR.denied, message);
const failed = (message: string) =>
  new BridgeError(BRIDGE_ERROR.failed, message);

const TOO_MANY = "Too many calls. Try again shortly.";
const GENERIC = "The call failed.";

const TRPC_ERRORS: Record<string, () => BridgeError> = {
  BAD_REQUEST: () =>
    failed("The request was not accepted. Check the key, value and size."),
  FORBIDDEN: () => denied("This artifact isn't allowed to do that."),
  NOT_FOUND: () => denied("Artifact or version not found."),
  PAYLOAD_TOO_LARGE: () => failed("The result is too large."),
  PRECONDITION_FAILED: () => failed("Connect this tool first, then try again."),
  TOO_MANY_REQUESTS: () => failed(TOO_MANY),
  UNAUTHORIZED: () =>
    denied("Your session has ended. Reload the page to sign in again."),
};

const LINK_ERRORS: Record<number, () => BridgeError> = {
  403: () => denied("This link doesn't allow that tool."),
  404: () => denied("This link is not available."),
  429: () => failed(TOO_MANY),
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const trpcCode = (error: unknown): string | null => {
  const record = asRecord(error);
  const direct = asRecord(record?.data)?.code;
  if (typeof direct === "string") {
    return direct;
  }
  const shaped = asRecord(asRecord(record?.shape)?.data)?.code;
  return typeof shaped === "string" ? shaped : null;
};

/** Turns anything a port threw into a `BridgeError` with a fixed message. */
export function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  if (error instanceof LinkCallError) {
    return (LINK_ERRORS[error.status] ?? (() => failed(GENERIC)))();
  }
  const code = trpcCode(error);
  const mapped = code === null ? undefined : TRPC_ERRORS[code];
  return (mapped ?? (() => failed(GENERIC)))();
}

const guarded =
  <Args extends unknown[], Out>(run: (...args: Args) => Promise<Out>) =>
  async (...args: Args): Promise<Out> => {
    try {
      return await run(...args);
    } catch (error) {
      throw toBridgeError(error);
    }
  };

const toolResult = (result: unknown): ToolsCallResult => {
  const text =
    typeof result === "string" ? result : (JSON.stringify(result) ?? "");
  return {
    content: [{ text, type: "text" }],
    ...(result === undefined ? {} : { structuredContent: result }),
  };
};

export function createCallHandlers(options: {
  calls: FrameCalls;
  onMessage?: (text: string) => void | Promise<void>;
}): BridgeHandlers {
  const { calls, onMessage } = options;

  const requireMember = (): MemberCalls => {
    if (calls.viewer === "link") {
      throw denied("Shared links can't change app storage.");
    }
    return calls;
  };

  /** A link holder reads the shared area and nothing else. */
  const refuseOtherArea = (scope: ArtifactStorageScope): void => {
    if (scope !== "shared") {
      throw denied("Shared links can read only the shared area.");
    }
  };

  return {
    "storage/delete": guarded(async ({ params }) => {
      await requireMember().storageDelete(params);
      return {};
    }),
    "storage/get": guarded(async ({ params }) => {
      if (calls.viewer === "link") {
        refuseOtherArea(params.scope);
        return { value: (await calls.storageGet({ key: params.key })).value };
      }
      const { value } = await calls.storageGet(params);
      return { value };
    }),
    "storage/list": guarded(async ({ params }) => {
      if (calls.viewer === "link") {
        refuseOtherArea(params.scope);
        const { keys } = await calls.storageList({ prefix: params.prefix });
        return { keys };
      }
      const { keys } = await calls.storageList(params);
      return { keys };
    }),
    "storage/set": guarded(async ({ params }) => {
      await requireMember().storageSet(params);
      return {};
    }),
    "tools/call": guarded(async ({ params }) => {
      const { result } = await calls.callTool({
        arguments: params.arguments,
        tool: params.name,
      });
      return toolResult(result);
    }),
    "ui/message": guarded(async ({ params }) => {
      if (!onMessage) {
        throw denied("This viewer doesn't take messages from the artifact.");
      }
      const text = params.content.map((block) => block.text).join("\n");
      if (text.length > MAX_MESSAGE_CHARS) {
        throw denied("That message is too long.");
      }
      await onMessage(text);
      return {};
    }),
  };
}

/** The slice of the tRPC client the member adapter uses. */
export interface MemberTrpc {
  artifacts: {
    callTool: {
      mutate: (input: {
        arguments?: Record<string, unknown>;
        artifactId: string;
        tool: string;
        versionId: string;
      }) => Promise<{ result?: unknown }>;
    };
    storageDelete: {
      mutate: (input: {
        artifactId: string;
        key: string;
        scope: ArtifactStorageScope;
      }) => Promise<unknown>;
    };
    storageGet: {
      query: (input: {
        artifactId: string;
        key: string;
        scope: ArtifactStorageScope;
      }) => Promise<StorageGetResult>;
    };
    storageList: {
      query: (input: {
        artifactId: string;
        prefix?: string;
        scope: ArtifactStorageScope;
      }) => Promise<StorageListResult>;
    };
    storageSet: {
      mutate: (input: {
        artifactId: string;
        key: string;
        scope: ArtifactStorageScope;
        value: StorageSetValue;
      }) => Promise<unknown>;
    };
  };
}

export function memberCallsFromTrpc(
  trpc: MemberTrpc,
  ids: { artifactId: string; versionId: string }
): MemberCalls {
  const { artifactId, versionId } = ids;
  const { artifacts } = trpc;
  return {
    callTool: (input) =>
      artifacts.callTool.mutate({ ...input, artifactId, versionId }),
    storageDelete: (input) =>
      artifacts.storageDelete.mutate({ ...input, artifactId }),
    storageGet: (input) => artifacts.storageGet.query({ ...input, artifactId }),
    storageList: (input) =>
      artifacts.storageList.query({ ...input, artifactId }),
    storageSet: (input) =>
      artifacts.storageSet.mutate({ ...input, artifactId }),
  };
}

export function linkCallsFromFetch(
  token: string,
  fetchFn: typeof fetch = fetch
): LinkCalls {
  const post = async (path: string, payload: object): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFn(
        `/api/share/${encodeURIComponent(token)}/${path}`,
        {
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
    } catch (error) {
      throw new LinkCallError(0, { cause: error });
    }
    if (response.status !== 200) {
      throw new LinkCallError(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new LinkCallError(502, { cause: error });
    }
    const parsed = shareCallResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new LinkCallError(502);
    }
    return parsed.data.result;
  };

  return {
    callTool: async ({ arguments: args, tool }) => ({
      result: await post(
        "call",
        args === undefined ? { tool } : { arguments: args, tool }
      ),
    }),
    storageGet: async ({ key }) => {
      const result = await post("storage", { key, op: "get" });
      return { value: (result ?? null) as StorageGetResult["value"] };
    },
    storageList: async ({ prefix }) => {
      const result = await post(
        "storage",
        prefix === undefined ? { op: "list" } : { op: "list", prefix }
      );
      if (
        !(
          Array.isArray(result) &&
          result.every((key) => typeof key === "string")
        )
      ) {
        throw new LinkCallError(502);
      }
      return { keys: result as string[] };
    },
  };
}
