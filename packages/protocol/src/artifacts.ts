// What the Worker, the frame and the artifact page agree on (A.1). Spec:
// docs/v3/artifacts-prd.md.

import {
  ARTIFACT_AUDIENCES,
  ARTIFACT_AUTHOR_KINDS,
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  ARTIFACT_PIN_SURFACES,
  ARTIFACT_SHARE_DATA_MODES,
  ARTIFACT_VERSION_STATUSES,
  ARTIFACT_VIEW_OUTCOMES,
  ARTIFACT_VIEW_SURFACES,
  ARTIFACT_VIEWER_KINDS,
} from "@repo/db/shared";
import { z } from "zod";

/**
 * What a `hm_view_` token says. `expiresAt` is Unix seconds. `shareId` is set
 * for a link viewer, `userId` for a member.
 */
export const viewTokenClaimsSchema = z.strictObject({
  artifactId: z.uuid(),
  expiresAt: z.int().positive(),
  shareId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  versionId: z.string().min(1),
  viewer: z.enum(ARTIFACT_VIEWER_KINDS),
  /** The artifact's workspace, so the content route can read R2 without D1. */
  workspaceId: z.string().min(1),
});
export type ViewTokenClaims = z.infer<typeof viewTokenClaimsSchema>;

/** Prefix of a view token, which the content URL carries. */
export const ARTIFACT_VIEW_TOKEN_PREFIX = "hm_view_";

/** Prefix of a share link token, which `/s/<token>` carries. */
export const ARTIFACT_SHARE_TOKEN_PREFIX = "hm_share_";

/** Folder inside the content path that the platform owns. Agents can't write it. */
export const ARTIFACT_RESERVED_PREFIX = "_hm/";

/** True for a path under the reserved folder, or the folder itself. */
export const isReservedArtifactPath = (path: string): boolean =>
  path.startsWith(ARTIFACT_RESERVED_PREFIX) || path === "_hm";

const ARTIFACT_PATH_MAX_LENGTH = 512;

/** A file path inside a version: relative, no dot segments, not reserved. */
export const artifactPathSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_PATH_MAX_LENGTH)
  .refine((path) => !(path.startsWith("/") || path.includes("\\")), {
    message: "path must be relative and use forward slashes",
  })
  .refine(
    (path) =>
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    { message: "path must not have empty, . or .. segments" }
  )
  .refine((path) => !isReservedArtifactPath(path), {
    message: `path must not be under ${ARTIFACT_RESERVED_PREFIX}`,
  });

export const artifactManifestFileSchema = z.strictObject({
  contentType: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lower-case hex"),
  size: z.int().nonnegative().max(ARTIFACT_FILE_MAX_BYTES),
});
export type ArtifactManifestFile = z.infer<typeof artifactManifestFileSchema>;

/** The file tree of one version. `entry` is a key of `files`. */
export const artifactManifestSchema = z
  .strictObject({
    entry: artifactPathSchema,
    files: z.record(artifactPathSchema, artifactManifestFileSchema),
  })
  .superRefine((manifest, ctx) => {
    const files = Object.values(manifest.files);
    if (!(manifest.entry in manifest.files)) {
      ctx.addIssue({
        code: "custom",
        message: "entry must be one of the files",
        path: ["entry"],
      });
    }
    if (files.length > ARTIFACT_MAX_FILES) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${ARTIFACT_MAX_FILES} files`,
        path: ["files"],
      });
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${ARTIFACT_MAX_BYTES} bytes in all`,
        path: ["files"],
      });
    }
  });
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

/** Content type by lower-case file extension. */
export const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** Content type for a path by its extension, `application/octet-stream` if unknown. */
export const contentTypeForPath = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return FALLBACK_CONTENT_TYPE;
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(ARTIFACT_CONTENT_TYPES, extension)
    ? (ARTIFACT_CONTENT_TYPES[extension] ?? FALLBACK_CONTENT_TYPE)
    : FALLBACK_CONTENT_TYPE;
};

/**
 * The one builder for a content path: `/a/<uuid>/c/<token>/<path>`. Each path
 * segment is encoded, slashes stay. An empty path gives a trailing slash.
 */
export const artifactContentPath = (input: {
  artifactId: string;
  path?: string;
  token: string;
}): string => {
  const path = (input.path ?? "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/a/${input.artifactId}/c/${encodeURIComponent(input.token)}/${path}`;
};

const CONTENT_PATH_REGEX = /^\/a\/([^/]+)\/c\/([^/]+)\/(.*)$/;
const uuidSchema = z.uuid();

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** Inverse of `artifactContentPath`, for the Worker route. Null if it doesn't fit. */
export const parseArtifactContentPath = (
  pathname: string
): { artifactId: string; path: string; token: string } | null => {
  const match = CONTENT_PATH_REGEX.exec(pathname);
  if (!match) {
    return null;
  }
  const [, artifactId = "", rawToken = "", rawPath = ""] = match;
  const token = decodeSegment(rawToken);
  if (!(uuidSchema.safeParse(artifactId).success && token)) {
    return null;
  }
  const parts: string[] = [];
  if (rawPath !== "") {
    for (const raw of rawPath.split("/")) {
      const part = decodeSegment(raw);
      if (part === null || part === "" || part === "." || part === "..") {
        return null;
      }
      if (part.includes("/") || part.includes("\\")) {
        return null;
      }
      parts.push(part);
    }
  }
  return { artifactId, path: parts.join("/"), token };
};

// Bridge: JSON-RPC 2.0 over postMessage, with the MCP Apps method names
// (ext-apps specification 2026-01-26).

const jsonRpcIdSchema = z.union([z.string(), z.int()]);

/** A request: has an `id`, expects a response. */
export const jsonRpcRequestSchema = <
  Method extends string,
  Params extends z.ZodType,
>(
  method: Method,
  paramsSchema: Params
) =>
  z.strictObject({
    id: jsonRpcIdSchema,
    jsonrpc: z.literal("2.0"),
    method: z.literal(method),
    params: paramsSchema,
  });

/** A notification: no `id`, no response. */
export const jsonRpcNotificationSchema = <
  Method extends string,
  Params extends z.ZodType,
>(
  method: Method,
  paramsSchema: Params
) =>
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal(method),
    params: paramsSchema,
  });

/** A success response. */
export const jsonRpcResultSchema = <Result extends z.ZodType>(
  resultSchema: Result
) =>
  z.strictObject({
    id: jsonRpcIdSchema,
    jsonrpc: z.literal("2.0"),
    result: resultSchema,
  });

/** An error response. */
export const jsonRpcErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.int(),
    data: z.json().optional(),
    message: z.string(),
  }),
  id: jsonRpcIdSchema.nullable(),
  jsonrpc: z.literal("2.0"),
});
export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;

const emptyResultSchema = z.strictObject({});

// ui/initialize
export const uiInitializeParamsSchema = z.strictObject({
  // The MCP Apps spec requires it; the frame ignores its content.
  appCapabilities: z.record(z.string(), z.unknown()).optional(),
  appInfo: z.strictObject({ name: z.string(), version: z.string() }).optional(),
  /** The frame's one-time value from the iframe URL fragment (`#hm=<nonce>`). */
  nonce: z.string().min(1).optional(),
  protocolVersion: z.string().min(1),
});
export const uiInitializeRequestSchema = jsonRpcRequestSchema(
  "ui/initialize",
  uiInitializeParamsSchema
);
export type UiInitializeRequest = z.infer<typeof uiInitializeRequestSchema>;

export const uiInitializeResultSchema = z.strictObject({
  theme: z.enum(["light", "dark"]),
  version: z.strictObject({ createdAt: z.string(), number: z.int() }),
  viewer: z.enum(["member", "link"]),
});
export type UiInitializeResult = z.infer<typeof uiInitializeResultSchema>;
export const uiInitializeResponseSchema = jsonRpcResultSchema(
  uiInitializeResultSchema
);

// ui/notifications/initialized, sent by the page once it has the initialize result
export const uiInitializedNotificationSchema = jsonRpcNotificationSchema(
  "ui/notifications/initialized",
  z.strictObject({}).optional()
);
export type UiInitializedNotification = z.infer<
  typeof uiInitializedNotificationSchema
>;

// ui/notifications/size-changed
export const uiSizeChangedNotificationSchema = jsonRpcNotificationSchema(
  "ui/notifications/size-changed",
  z.strictObject({
    height: z.number().nonnegative().optional(),
    width: z.number().nonnegative().optional(),
  })
);
export type UiSizeChangedNotification = z.infer<
  typeof uiSizeChangedNotificationSchema
>;

// ui/open-link
export const uiOpenLinkRequestSchema = jsonRpcRequestSchema(
  "ui/open-link",
  z.strictObject({ url: z.url({ protocol: /^https?$/ }) })
);
export type UiOpenLinkRequest = z.infer<typeof uiOpenLinkRequestSchema>;
export const uiOpenLinkResponseSchema = jsonRpcResultSchema(emptyResultSchema);

// ui/message
export const uiMessageRequestSchema = jsonRpcRequestSchema(
  "ui/message",
  z.strictObject({
    content: z
      .array(z.strictObject({ text: z.string(), type: z.literal("text") }))
      .min(1),
    role: z.literal("user"),
  })
);
export type UiMessageRequest = z.infer<typeof uiMessageRequestSchema>;
export const uiMessageResponseSchema = jsonRpcResultSchema(emptyResultSchema);

// tools/call (phase 2)
export const toolsCallRequestSchema = jsonRpcRequestSchema(
  "tools/call",
  z.strictObject({
    arguments: z.record(z.string(), z.unknown()).optional(),
    name: z.string().min(1),
  })
);
export type ToolsCallRequest = z.infer<typeof toolsCallRequestSchema>;

export const toolsCallResultSchema = z.strictObject({
  content: z.array(
    z.strictObject({ text: z.string(), type: z.literal("text") })
  ),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});
export type ToolsCallResult = z.infer<typeof toolsCallResultSchema>;
export const toolsCallResponseSchema = jsonRpcResultSchema(
  toolsCallResultSchema
);

// storage/* (phase 2): per-viewer or shared
export const artifactStorageScopeSchema = z.enum(["viewer", "shared"]);
export type ArtifactStorageScope = z.infer<typeof artifactStorageScopeSchema>;

const storageKeySchema = z.string().min(1);

export const storageGetRequestSchema = jsonRpcRequestSchema(
  "storage/get",
  z.strictObject({ key: storageKeySchema, scope: artifactStorageScopeSchema })
);
export const storageGetResultSchema = z.strictObject({
  value: z.json().nullable(),
});
export type StorageGetResult = z.infer<typeof storageGetResultSchema>;
export const storageGetResponseSchema = jsonRpcResultSchema(
  storageGetResultSchema
);

export const storageSetRequestSchema = jsonRpcRequestSchema(
  "storage/set",
  z.strictObject({
    key: storageKeySchema,
    scope: artifactStorageScopeSchema,
    value: z.json(),
  })
);
export const storageSetResponseSchema = jsonRpcResultSchema(emptyResultSchema);

export const storageDeleteRequestSchema = jsonRpcRequestSchema(
  "storage/delete",
  z.strictObject({ key: storageKeySchema, scope: artifactStorageScopeSchema })
);
export const storageDeleteResponseSchema =
  jsonRpcResultSchema(emptyResultSchema);

export const storageListRequestSchema = jsonRpcRequestSchema(
  "storage/list",
  z.strictObject({
    prefix: z.string().optional(),
    scope: artifactStorageScopeSchema,
  })
);
export const storageListResultSchema = z.strictObject({
  keys: z.array(z.string()),
});
export type StorageListResult = z.infer<typeof storageListResultSchema>;
export const storageListResponseSchema = jsonRpcResultSchema(
  storageListResultSchema
);

/** Every page-to-frame request and notification, told apart by `method`. */
export const bridgeMessageSchema = z.discriminatedUnion("method", [
  storageDeleteRequestSchema,
  storageGetRequestSchema,
  storageListRequestSchema,
  storageSetRequestSchema,
  toolsCallRequestSchema,
  uiInitializeRequestSchema,
  uiInitializedNotificationSchema,
  uiMessageRequestSchema,
  uiOpenLinkRequestSchema,
  uiSizeChangedNotificationSchema,
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

/** The parsed bridge message, or null when the value isn't one. */
export const parseBridgeMessage = (value: unknown): BridgeMessage | null => {
  const result = bridgeMessageSchema.safeParse(value);
  return result.success ? result.data : null;
};

// tRPC inputs and outputs, the thread part and the share HTTP responses.
// Spec: docs/v3/artifacts-prd.md, "Interfaces" and "HTTP routes".

const idSchema = z.string().min(1);
const artifactIdSchema = z.uuid();
const timestampSchema = z.iso.datetime();
const emptySchema = z.strictObject({});
const versionNumberSchema = z.int().positive();

const kindSchema = z.enum(ARTIFACT_KINDS);
const audienceSchema = z.enum(ARTIFACT_AUDIENCES);
const dataModeSchema = z.enum(ARTIFACT_SHARE_DATA_MODES);
const pinSurfaceSchema = z.enum(ARTIFACT_PIN_SURFACES);

/** The version a link or the viewer opened: its number and when it was made. */
const openedVersionSchema = z.strictObject({
  createdAt: timestampSchema,
  number: versionNumberSchema,
});

// Entities

export const artifactVersionSchema = z.strictObject({
  authorId: idSchema,
  authorKind: z.enum(ARTIFACT_AUTHOR_KINDS),
  authorRunId: idSchema.nullable(),
  createdAt: timestampSchema,
  entry: z.string(),
  fileCount: z.int().nonnegative(),
  hasThumbnail: z.boolean(),
  id: idSchema,
  message: z.string(),
  number: versionNumberSchema,
  parentNumber: versionNumberSchema.nullable(),
  sourceLibraryPath: z.string().nullable(),
  status: z.enum(ARTIFACT_VERSION_STATUSES),
  totalBytes: z.int().nonnegative(),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

export const artifactShareSchema = z.strictObject({
  artifactId: artifactIdSchema,
  createdAt: timestampSchema,
  createdBy: idSchema,
  dataMode: dataModeSchema,
  expiresAt: timestampSchema.nullable(),
  grantedBy: idSchema.nullable(),
  id: idSchema,
  lastOpenedAt: timestampSchema.nullable(),
  liveTools: z.array(z.string()).nullable(),
  openCount: z.int().nonnegative(),
  revokedAt: timestampSchema.nullable(),
  /** Derived: `revoked` wins over `expired`. */
  status: z.enum(["active", "revoked", "expired"]),
  /** The copyable link. */
  url: z.string().min(1),
  versionId: idSchema.nullable(),
});
export type ArtifactShare = z.infer<typeof artifactShareSchema>;

/** One access-log row. There is no visitor hash and no full IP. */
export const artifactViewSchema = z.strictObject({
  artifactId: artifactIdSchema,
  asn: z.string().nullable(),
  asOrg: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  createdAt: timestampSchema,
  id: idSchema,
  ipPrefix: z.string().nullable(),
  outcome: z.enum(ARTIFACT_VIEW_OUTCOMES),
  referrerHost: z.string().nullable(),
  region: z.string().nullable(),
  shareId: idSchema.nullable(),
  surface: z.enum(ARTIFACT_VIEW_SURFACES),
  toolKey: z.string().nullable(),
  userAgent: z.string().nullable(),
  userId: idSchema.nullable(),
  versionId: idSchema.nullable(),
});
export type ArtifactView = z.infer<typeof artifactViewSchema>;

/** One row of the artifacts list. */
export const artifactCardSchema = z.strictObject({
  agentName: z.string().nullable(),
  artifactId: artifactIdSchema,
  audience: audienceSchema,
  currentVersion: versionNumberSchema,
  description: z.string().nullable(),
  hasThumbnail: z.boolean(),
  kind: kindSchema,
  /** Active links only. */
  linkCount: z.int().nonnegative(),
  ownerName: z.string().nullable(),
  ownerUserId: idSchema.nullable(),
  pinned: z.boolean(),
  title: z.string(),
  updatedAt: timestampSchema,
});
export type ArtifactCard = z.infer<typeof artifactCardSchema>;

export const artifactDetailSchema = artifactCardSchema.extend({
  canCreateLiveLink: z.boolean(),
  canManage: z.boolean(),
  createdAt: timestampSchema,
  currentVersion: artifactVersionSchema,
  handedToAgentId: idSchema.nullable(),
  linksEnabled: z.boolean(),
  /** Set only when the viewer can see that session. */
  madeIn: z
    .strictObject({
      runId: idSchema,
      sessionId: idSchema,
      title: z.string().nullable(),
    })
    .nullable(),
});
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

/** The part the thread fold emits for an artifact. */
export const artifactThreadPartSchema = z.strictObject({
  artifactId: artifactIdSchema,
  kind: kindSchema,
  title: z.string(),
  toolCallId: idSchema.nullable(),
  type: z.literal("artifact"),
  version: versionNumberSchema,
  versionId: idSchema,
});
export type ArtifactThreadPart = z.infer<typeof artifactThreadPartSchema>;

// tRPC: core router

const artifactOnlyInput = z.strictObject({ artifactId: artifactIdSchema });

export const artifactsListInputSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  kind: kindSchema.optional(),
  madeBy: z.enum(["agent", "person"]).optional(),
  /** Only artifacts a version of which this run published. */
  runId: idSchema.optional(),
  shared: z.boolean().optional(),
});
export type ArtifactsListInput = z.infer<typeof artifactsListInputSchema>;
export const artifactsListOutputSchema = z.strictObject({
  items: z.array(artifactCardSchema),
  next: z.string().min(1).optional(),
});
export type ArtifactsListOutput = z.infer<typeof artifactsListOutputSchema>;

export const artifactsGetInputSchema = artifactOnlyInput;
export type ArtifactsGetInput = z.infer<typeof artifactsGetInputSchema>;
export const artifactsGetOutputSchema = artifactDetailSchema;
export type ArtifactsGetOutput = z.infer<typeof artifactsGetOutputSchema>;

export const artifactsVersionsInputSchema = artifactOnlyInput;
export type ArtifactsVersionsInput = z.infer<
  typeof artifactsVersionsInputSchema
>;
export const artifactsVersionsOutputSchema = z.array(artifactVersionSchema);
export type ArtifactsVersionsOutput = z.infer<
  typeof artifactsVersionsOutputSchema
>;

export const artifactsRestoreInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  version: versionNumberSchema,
});
export type ArtifactsRestoreInput = z.infer<typeof artifactsRestoreInputSchema>;
export const artifactsRestoreOutputSchema = z.strictObject({
  version: versionNumberSchema,
});
export type ArtifactsRestoreOutput = z.infer<
  typeof artifactsRestoreOutputSchema
>;

export const artifactsRenameInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  title: z.string().min(1).max(120),
});
export type ArtifactsRenameInput = z.infer<typeof artifactsRenameInputSchema>;
export const artifactsRenameOutputSchema = emptySchema;
export type ArtifactsRenameOutput = z.infer<typeof artifactsRenameOutputSchema>;

export const artifactsSetAudienceInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  audience: audienceSchema,
});
export type ArtifactsSetAudienceInput = z.infer<
  typeof artifactsSetAudienceInputSchema
>;
export const artifactsSetAudienceOutputSchema = emptySchema;
export type ArtifactsSetAudienceOutput = z.infer<
  typeof artifactsSetAudienceOutputSchema
>;

export const artifactsRemoveInputSchema = artifactOnlyInput;
export type ArtifactsRemoveInput = z.infer<typeof artifactsRemoveInputSchema>;
export const artifactsRemoveOutputSchema = emptySchema;
export type ArtifactsRemoveOutput = z.infer<typeof artifactsRemoveOutputSchema>;

export const artifactsPromoteInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  versionId: idSchema,
});
export type ArtifactsPromoteInput = z.infer<typeof artifactsPromoteInputSchema>;
export const artifactsPromoteOutputSchema = z.strictObject({
  version: versionNumberSchema,
});
export type ArtifactsPromoteOutput = z.infer<
  typeof artifactsPromoteOutputSchema
>;

export const artifactsDecideGrantInputSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  grantId: idSchema,
});
export type ArtifactsDecideGrantInput = z.infer<
  typeof artifactsDecideGrantInputSchema
>;
export const artifactsDecideGrantOutputSchema = emptySchema;
export type ArtifactsDecideGrantOutput = z.infer<
  typeof artifactsDecideGrantOutputSchema
>;

export const artifactsCallToolInputSchema = z.strictObject({
  arguments: z.record(z.string(), z.unknown()).optional(),
  artifactId: artifactIdSchema,
  /** `serverKey/tool`. */
  tool: idSchema,
  versionId: idSchema,
});
export type ArtifactsCallToolInput = z.infer<
  typeof artifactsCallToolInputSchema
>;
export const artifactsCallToolOutputSchema = z.strictObject({
  result: z.unknown(),
});
export type ArtifactsCallToolOutput = z.infer<
  typeof artifactsCallToolOutputSchema
>;

export const artifactsPinInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  surface: pinSurfaceSchema,
});
export type ArtifactsPinInput = z.infer<typeof artifactsPinInputSchema>;
export const artifactsPinOutputSchema = emptySchema;
export type ArtifactsPinOutput = z.infer<typeof artifactsPinOutputSchema>;

export const artifactsUnpinInputSchema = artifactsPinInputSchema;
export type ArtifactsUnpinInput = z.infer<typeof artifactsUnpinInputSchema>;
export const artifactsUnpinOutputSchema = emptySchema;
export type ArtifactsUnpinOutput = z.infer<typeof artifactsUnpinOutputSchema>;

export const artifactsHandToInputSchema = z.strictObject({
  agentId: idSchema.nullable(),
  artifactId: artifactIdSchema,
});
export type ArtifactsHandToInput = z.infer<typeof artifactsHandToInputSchema>;
export const artifactsHandToOutputSchema = emptySchema;
export type ArtifactsHandToOutput = z.infer<typeof artifactsHandToOutputSchema>;

// tRPC: shares router

export const artifactsOpenInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  surface: z.enum(["viewer", "thread"]),
  version: versionNumberSchema.optional(),
});
export type ArtifactsOpenInput = z.infer<typeof artifactsOpenInputSchema>;
export const artifactsOpenOutputSchema = z.strictObject({
  contentUrl: z.string().min(1),
  expiresAt: timestampSchema,
  version: openedVersionSchema,
});
export type ArtifactsOpenOutput = z.infer<typeof artifactsOpenOutputSchema>;

export const artifactsSharesInputSchema = artifactOnlyInput;
export type ArtifactsSharesInput = z.infer<typeof artifactsSharesInputSchema>;
export const artifactsSharesOutputSchema = z.array(artifactShareSchema);
export type ArtifactsSharesOutput = z.infer<typeof artifactsSharesOutputSchema>;

/** `liveTools` only goes with `dataMode: "live"`, and a live link needs at least one. */
export const artifactsCreateShareInputSchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    dataMode: dataModeSchema.default("snapshot"),
    expiresAt: timestampSchema.nullable().optional(),
    liveTools: z.array(idSchema).optional(),
    versionId: idSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const tools = value.liveTools;
    if (value.dataMode === "live") {
      if (!tools || tools.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "A live link needs at least one tool.",
          path: ["liveTools"],
        });
      }
    } else if (tools !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "liveTools only applies to a live link.",
        path: ["liveTools"],
      });
    }
  });
export type ArtifactsCreateShareInput = z.input<
  typeof artifactsCreateShareInputSchema
>;
export const artifactsCreateShareOutputSchema = artifactShareSchema;
export type ArtifactsCreateShareOutput = z.infer<
  typeof artifactsCreateShareOutputSchema
>;

export const artifactsRevokeShareInputSchema = z.strictObject({
  shareId: idSchema,
});
export type ArtifactsRevokeShareInput = z.infer<
  typeof artifactsRevokeShareInputSchema
>;
export const artifactsRevokeShareOutputSchema = emptySchema;
export type ArtifactsRevokeShareOutput = z.infer<
  typeof artifactsRevokeShareOutputSchema
>;

export const artifactsViewsInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  cursor: z.string().min(1).optional(),
  shareId: idSchema.optional(),
});
export type ArtifactsViewsInput = z.infer<typeof artifactsViewsInputSchema>;
export const artifactsViewsOutputSchema = z.strictObject({
  items: z.array(artifactViewSchema),
  next: z.string().min(1).optional(),
});
export type ArtifactsViewsOutput = z.infer<typeof artifactsViewsOutputSchema>;

export const artifactsSetLinksEnabledInputSchema = z.strictObject({
  enabled: z.boolean(),
});
export type ArtifactsSetLinksEnabledInput = z.infer<
  typeof artifactsSetLinksEnabledInputSchema
>;
export const artifactsLinksEnabledOutputSchema = z.strictObject({
  enabled: z.boolean(),
});
export type ArtifactsLinksEnabledOutput = z.infer<
  typeof artifactsLinksEnabledOutputSchema
>;

export const artifactsSetLinksEnabledOutputSchema = emptySchema;
export type ArtifactsSetLinksEnabledOutput = z.infer<
  typeof artifactsSetLinksEnabledOutputSchema
>;

// HTTP: share routes

/** What a share link answers for a revoked, expired, unknown or disabled link. */
export const SHARE_UNAVAILABLE_MESSAGE = "This link is not available.";

export const shareUnavailableSchema = z.strictObject({
  error: z.literal(SHARE_UNAVAILABLE_MESSAGE),
});
export type ShareUnavailable = z.infer<typeof shareUnavailableSchema>;

export const shareOpenResponseSchema = z.strictObject({
  agentName: z.string().nullable(),
  contentUrl: z.string().min(1),
  expiresAt: timestampSchema,
  kind: kindSchema,
  ownerName: z.string().nullable(),
  title: z.string(),
  version: openedVersionSchema,
  workspaceName: z.string(),
});
export type ShareOpenResponse = z.infer<typeof shareOpenResponseSchema>;

export const shareCallInputSchema = z.strictObject({
  arguments: z.record(z.string(), z.unknown()).optional(),
  tool: idSchema,
});
export type ShareCallInput = z.infer<typeof shareCallInputSchema>;

export const shareCallResponseSchema = z.strictObject({
  result: z.unknown(),
});
export type ShareCallResponse = z.infer<typeof shareCallResponseSchema>;

export const shareCallErrorSchema = z.strictObject({ error: z.string() });
export type ShareCallError = z.infer<typeof shareCallErrorSchema>;
