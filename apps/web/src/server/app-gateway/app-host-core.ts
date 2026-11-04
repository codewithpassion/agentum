/**
 * The logic behind `env.AGENTUM`, the one binding an app's server part holds.
 * `AppHost` (see `entrypoints.ts`) builds one per call from its props, which
 * come from the verified view token and not from app code. Link viewers are
 * checked against the share on every call (R2.12), and the store port is
 * never reached without `canWrite` saying yes for a write.
 */
import type { AppGatewayPorts, AppToolCall, ShareState } from "./ports.ts";
import type {
  AgentumHost,
  AppErrorCode,
  AppHostProps,
  AppStoreScope,
  AppViewer,
  StorageArea,
} from "./types.ts";

export const MAX_KEY_BYTES = 256;
export const MAX_VALUE_BYTES = 1024 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const TOOL_KEY = /^[^/\s#]+\/[^/\s#]+$/;

const encoder = new TextEncoder();

/** An `Error` whose message starts with `code`, which is how errors cross RPC. */
export const appError = (code: AppErrorCode, detail: string): Error =>
  new Error(`${code}: ${detail}`);

type Ports = Pick<AppGatewayPorts, "calls" | "canWrite" | "shares" | "store">;

/** Who is calling, after the share (if any) was read fresh. */
type Caller =
  | { kind: "member"; userId: string; viewer: AppViewer }
  | {
      dataMode: "snapshot" | "live";
      kind: "link";
      shareId: string;
      viewer: AppViewer;
    }
  | { kind: "test" };

const callerOf = async (props: AppHostProps, ports: Ports): Promise<Caller> => {
  const { viewer } = props;
  // EP.1 exposes the contract; EP.2/EP.3 implement these viewers' capabilities.
  if (viewer.kind === "endpoint" || viewer.kind === "reply") {
    throw appError(
      "not_granted",
      "app endpoint capabilities are not available yet"
    );
  }
  if (viewer.kind === "test") {
    return { kind: "test" };
  }
  if (viewer.kind === "member") {
    return { kind: "member", userId: viewer.userId, viewer };
  }
  const state: ShareState = await ports.shares.state(
    viewer.shareId,
    props.artifactId
  );
  if (!state.ok) {
    throw appError("forbidden", `link is ${state.reason}`);
  }
  return {
    dataMode: state.dataMode,
    kind: "link",
    shareId: viewer.shareId,
    viewer: { dataMode: state.dataMode, kind: "link", shareId: viewer.shareId },
  };
};

const viewerKeyOf = (caller: Caller): string => {
  if (caller.kind === "member") {
    return `u:${caller.userId}`;
  }
  return caller.kind === "link" ? `l:${caller.shareId}` : "test";
};

const checkArea = (area: unknown): StorageArea => {
  if (area !== "viewer" && area !== "shared") {
    throw new TypeError("the area must be viewer or shared");
  }
  return area;
};

const byteLength = (value: string): number => encoder.encode(value).byteLength;

const checkKey = (key: unknown): string => {
  if (typeof key !== "string" || key === "") {
    throw new TypeError("the key must be a non-empty string");
  }
  if (byteLength(key) > MAX_KEY_BYTES) {
    throw appError("too_large", `the key is over ${MAX_KEY_BYTES} bytes`);
  }
  return key;
};

const checkValue = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("the value must be a string");
  }
  if (byteLength(value) > MAX_VALUE_BYTES) {
    throw appError("too_large", `the value is over ${MAX_VALUE_BYTES} bytes`);
  }
  return value;
};

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(limit)));
};

export const createAppHost = (
  props: AppHostProps,
  ports: Ports
): AgentumHost => {
  const scopeOf = (caller: Caller, area: StorageArea): AppStoreScope => ({
    area,
    artifactId: props.artifactId,
    viewerKey: viewerKeyOf(caller),
  });

  /** A test viewer reads the shared area and nothing of a person's own. */
  const hasNothingIn = (caller: Caller, area: StorageArea): boolean =>
    caller.kind === "test" && area === "viewer";

  const mayWrite = async (area: StorageArea): Promise<Caller> => {
    const caller = await callerOf(props, ports);
    if (caller.kind === "test" || !ports.canWrite(caller.viewer, area)) {
      throw appError("forbidden", `this viewer cannot write the ${area} area`);
    }
    return caller;
  };

  const call = (caller: Caller, toolKey: string, args: unknown) => {
    if (caller.kind === "test") {
      throw appError("forbidden", "a test viewer cannot call tools");
    }
    if (typeof toolKey !== "string" || !TOOL_KEY.test(toolKey)) {
      throw appError("not_granted", String(toolKey));
    }
    const base: AppToolCall = {
      args,
      artifactId: props.artifactId,
      tool: toolKey,
      versionId: props.versionId,
      workspaceId: props.workspaceId,
    };
    if (caller.kind === "member") {
      return ports.calls.asMember({
        ...base,
        userId: caller.userId,
      });
    }
    if (caller.dataMode === "snapshot") {
      throw appError("forbidden", "snapshot links cannot call tools");
    }
    return ports.calls.asLink({
      ...base,
      meta: props.meta,
      shareId: caller.shareId,
    });
  };

  return {
    callTool: async (toolKey, args) =>
      call(await callerOf(props, ports), toolKey, args),

    deleteItem: async (area, key) => {
      checkArea(area);
      const caller = await mayWrite(area);
      await ports.store.delete(scopeOf(caller, area), checkKey(key));
    },

    getItem: async (area, key) => {
      checkArea(area);
      const caller = await callerOf(props, ports);
      const checked = checkKey(key);
      if (hasNothingIn(caller, area)) {
        return null;
      }
      return await ports.store.get(scopeOf(caller, area), checked);
    },

    listItems: async (area, prefix, limit) => {
      checkArea(area);
      const caller = await callerOf(props, ports);
      if (hasNothingIn(caller, area)) {
        return [];
      }
      return await ports.store.list(
        scopeOf(caller, area),
        typeof prefix === "string" ? prefix : "",
        clampLimit(limit)
      );
    },

    setItem: async (area, key, value) => {
      checkArea(area);
      const caller = await mayWrite(area);
      await ports.store.set(
        scopeOf(caller, area),
        checkKey(key),
        checkValue(value)
      );
    },
    startRun: () =>
      Promise.reject(
        appError("not_granted", "app hand-off is not available yet")
      ),

    whoami: async () => {
      const caller = await callerOf(props, ports);
      return {
        dataMode: caller.kind === "link" ? caller.dataMode : null,
        viewer: caller.kind,
      };
    },
  };
};
