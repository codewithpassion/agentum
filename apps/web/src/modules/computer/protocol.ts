/**
 * The v1 wire contract between a remote computer client and the relay.
 * One JSON text frame per message, snake_case fields. Heartbeats are the bare literals below so
 * `setWebSocketAutoResponse` can answer them without waking the Durable Object.
 * Treat it as frozen. A field may still be added when every older client and every stored row
 * still read correctly without it — which means a default — and anything a v1 client cannot parse
 * needs a new `protocol_version` instead.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";

/** Client heartbeat period; the relay treats a socket with no ping for STALE_AFTER_MS as gone. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_AFTER_MS = 25_000;
/** How often a waiting request re-checks the socket's last heartbeat. */
export const STALENESS_POLL_MS = 2000;
/** Added to a request's own timeout so the client's exit 124 wins the race. */
export const RELAY_GRACE_MS = 10_000;
export const MAX_IN_FLIGHT_EXEC = 4;
export const MAX_QUEUE_DEPTH = 32;

// Close codes. 4401 is terminal for the client: it stops retrying and exits.

/** The hello could not be read, so the server knows nothing about this machine it can act on. */
export const CLOSE_BAD_HELLO = 4400;
export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_STALE = 4408;

/**
 * The platform closes the whole socket on an oversized frame, so every path guards against it well
 * under the measured 33,554,432-byte ceiling rather than letting one write drop every request.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** File transfers move in chunks this size so a frame never approaches MAX_FRAME_BYTES. */
export const FILE_CHUNK_BYTES = 256 * 1024;

export const ComputerCapabilitiesSchema = z.object({
  /**
   * Whether the machine runs a desktop the desktop ops can drive. Defaults to false, so an older
   * client is never sent an op it would answer with `unknown_op`.
   */
  desktop: z.boolean().default(false),
  /** Why a desktop that was asked for is not running, or null. */
  desktop_unavailable_reason: z.string().max(256).nullable().default(null),
  git: z.boolean(),
  python3: z.boolean(),
  /**
   * Whether the skill downloader can run here. Only the machine can answer it: python3 and git on
   * PATH are not enough, the downloader also imports pydantic. Defaults to false so a client or a
   * stored row from before this field reads as "no skills" instead of failing to parse.
   */
  skills: z.boolean().default(false),
});
export type ComputerCapabilities = z.infer<typeof ComputerCapabilitiesSchema>;

/** A POSIX user name, reported for the UI and the activity log. */
const RUN_AS_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

const WORKDIR_MAX_LENGTH = 1024;

/**
 * The client's sessions root is the one path the server builds every session directory from, and it
 * arrives from a machine nobody here controls. It must be absolute, already normalised, and free of
 * anything that would change meaning in a shell or in the lexical containment check: an unnormalised
 * root silently stops matching that check and refuses every file transfer.
 */
export function isUsableWorkdir(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.length < 2 ||
    value.length > WORKDIR_MAX_LENGTH
  ) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || `'"\`\\$`.includes(character)) {
      return false;
    }
  }
  return value
    .split("/")
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Bounds and one field the machine alone can know: a client is not trusted, and these strings are
 * written to the database, shown in the UI and put in front of the model.
 */
export const HelloMessageSchema = z.object({
  arch: z.string().min(1).max(32),
  capabilities: ComputerCapabilitiesSchema,
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(32),
  protocol_version: z.literal(PROTOCOL_VERSION),
  run_as_user: z.string().regex(RUN_AS_USER_PATTERN),
  type: z.literal("hello"),
  version: z.string().min(1).max(64),
  /** Absolute path of the root the client keeps its per-session directories under. */
  workdir: z.string().refine(isUsableWorkdir),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** Control characters from a machine must not reach a log line, the UI or the model's prompt. */
export function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : character;
  }
  return out;
}

export const ExecRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  op: z.literal("exec"),
  timeout_ms: z.number(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export const CancelRequestSchema = z.object({
  op: z.literal("cancel"),
  target_id: z.string(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const FilePutRequestSchema = z.object({
  data_b64: z.string(),
  final: z.boolean(),
  op: z.literal("file_put"),
  path: z.string(),
  seq: z.number(),
  /** Hex sha256 of the whole file, sent on the final chunk only. */
  sha256: z.string().nullable(),
  transfer_id: z.string(),
});
export type FilePutRequest = z.infer<typeof FilePutRequestSchema>;

export const FileGetRequestSchema = z.object({
  max_bytes: z.number(),
  offset: z.number(),
  op: z.literal("file_get"),
  path: z.string(),
});
export type FileGetRequest = z.infer<typeof FileGetRequestSchema>;

/** The desktop is a fixed 1280x800, so coordinates are desktop pixels with no scaling. */
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;
export const DESKTOP_TYPE_MAX_CHARS = 512;
const DESKTOP_CLIPBOARD_MAX_BYTES = 64 * 1024;
export const DESKTOP_MAX_ACTIONS = 64;
const DESKTOP_KEYS_MAX_CHARS = 64;
const DESKTOP_SCROLL_MAX = 50;
/** Wheel clicks one input batch may scroll in total, so the batch fits its timeout. */
export const DESKTOP_SCROLL_BATCH_MAX = 60;
/** An xdotool chord such as `ctrl+l`; anything else could be read as an xdotool command. */
const DESKTOP_KEYS_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/** Server-chosen `timeout_ms` per desktop op. */
export const DESKTOP_SCREENSHOT_TIMEOUT_MS = 5000;
export const DESKTOP_CLIPBOARD_TIMEOUT_MS = 3000;
const DESKTOP_INPUT_BASE_TIMEOUT_MS = 2000;
const DESKTOP_INPUT_MS_PER_TYPED_CHAR = 5;

// The field schemas are exported so the model-facing tools reuse these bounds rather than restating them.
export const DesktopXSchema = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_WIDTH - 1);
export const DesktopYSchema = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_HEIGHT - 1);
export const DesktopButtonSchema = z.enum(["left", "middle", "right"]);
export const DesktopClickCountSchema = z.number().int().min(1).max(3);
export const DesktopScrollDeltaSchema = z
  .number()
  .int()
  .min(-DESKTOP_SCROLL_MAX)
  .max(DESKTOP_SCROLL_MAX);
export const DesktopKeysSchema = z
  .string()
  .max(DESKTOP_KEYS_MAX_CHARS)
  .regex(DESKTOP_KEYS_PATTERN);
export const DesktopTypeTextSchema = z
  .string()
  .min(1)
  .max(DESKTOP_TYPE_MAX_CHARS);
export const DesktopClipboardTextSchema = z
  .string()
  .refine(
    (text) =>
      new TextEncoder().encode(text).byteLength <= DESKTOP_CLIPBOARD_MAX_BYTES,
    {
      message: `Clipboard text is capped at ${String(DESKTOP_CLIPBOARD_MAX_BYTES)} bytes`,
    }
  );

// Each member is exported so the HTTP input route can name it in OpenAPI without restating it.
export const DesktopMouseMoveActionSchema = z.object({
  type: z.literal("mouse_move"),
  x: DesktopXSchema,
  y: DesktopYSchema,
});
export const DesktopMouseDownActionSchema = z.object({
  button: DesktopButtonSchema,
  type: z.literal("mouse_down"),
});
export const DesktopMouseUpActionSchema = z.object({
  button: DesktopButtonSchema,
  type: z.literal("mouse_up"),
});
export const DesktopClickActionSchema = z.object({
  button: DesktopButtonSchema,
  count: DesktopClickCountSchema,
  type: z.literal("click"),
  x: DesktopXSchema,
  y: DesktopYSchema,
});
export const DesktopScrollActionSchema = z.object({
  dx: DesktopScrollDeltaSchema,
  dy: DesktopScrollDeltaSchema,
  type: z.literal("scroll"),
  x: DesktopXSchema,
  y: DesktopYSchema,
});
export const DesktopKeyActionSchema = z.object({
  keys: DesktopKeysSchema,
  type: z.literal("key"),
});
export const DesktopTypeActionSchema = z.object({
  text: DesktopTypeTextSchema,
  type: z.literal("type"),
});

export const DesktopActionSchema = z.discriminatedUnion("type", [
  DesktopMouseMoveActionSchema,
  DesktopMouseDownActionSchema,
  DesktopMouseUpActionSchema,
  DesktopClickActionSchema,
  DesktopScrollActionSchema,
  DesktopKeyActionSchema,
  DesktopTypeActionSchema,
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;

/** The wheel clicks one scroll moves, counted the way the batch budget counts them. */
export function scrollClicks({ dx, dy }: { dx: number; dy: number }): number {
  return Math.abs(dx) + Math.abs(dy);
}

/** Whether a batch stays within the wheel clicks one input op may scroll. */
export function fitsScrollBudget(actions: readonly DesktopAction[]): boolean {
  return (
    actions.reduce(
      (total, action) =>
        total + (action.type === "scroll" ? scrollClicks(action) : 0),
      0
    ) <= DESKTOP_SCROLL_BATCH_MAX
  );
}

export const DESKTOP_SCROLL_BUDGET_MESSAGE = `One batch scrolls at most ${String(DESKTOP_SCROLL_BATCH_MAX)} wheel clicks`;

export const DesktopScreenshotRequestSchema = z.object({
  op: z.literal("desktop_screenshot"),
  /** JPEG quality 1..95; null lets the client use 60. */
  quality: z.number().int().min(1).max(95).nullable(),
});
export type DesktopScreenshotRequest = z.infer<
  typeof DesktopScreenshotRequestSchema
>;

export const DesktopInputRequestSchema = z.object({
  actions: z
    .array(DesktopActionSchema)
    .min(1)
    .max(DESKTOP_MAX_ACTIONS)
    .refine(fitsScrollBudget, { message: DESKTOP_SCROLL_BUDGET_MESSAGE }),
  op: z.literal("desktop_input"),
});
export type DesktopInputRequest = z.infer<typeof DesktopInputRequestSchema>;

export const DesktopClipboardGetRequestSchema = z.object({
  op: z.literal("desktop_clipboard_get"),
});
export type DesktopClipboardGetRequest = z.infer<
  typeof DesktopClipboardGetRequestSchema
>;

const DesktopClipboardSelectionSchema = z.enum(["clipboard", "primary"]);

export const DesktopClipboardSetRequestSchema = z.object({
  op: z.literal("desktop_clipboard_set"),
  selections: z
    .array(DesktopClipboardSelectionSchema)
    .min(1)
    .max(2)
    .refine((selections) => new Set(selections).size === selections.length, {
      message: "Selections must be unique",
    }),
  text: DesktopClipboardTextSchema,
});
export type DesktopClipboardSetRequest = z.infer<
  typeof DesktopClipboardSetRequestSchema
>;

export const ClientOpRequestSchema = z.discriminatedUnion("op", [
  ExecRequestSchema,
  CancelRequestSchema,
  FilePutRequestSchema,
  FileGetRequestSchema,
  DesktopScreenshotRequestSchema,
  DesktopInputRequestSchema,
  DesktopClipboardGetRequestSchema,
  DesktopClipboardSetRequestSchema,
]);
export type ClientOpRequest = z.infer<typeof ClientOpRequestSchema>;

const DESKTOP_OPS: ReadonlySet<string> = new Set([
  DesktopScreenshotRequestSchema.shape.op.value,
  DesktopInputRequestSchema.shape.op.value,
  DesktopClipboardGetRequestSchema.shape.op.value,
  DesktopClipboardSetRequestSchema.shape.op.value,
]);

/** Desktop ops are the only ones gated on the desktop capability and the lease. */
export function isDesktopOp(op: string): boolean {
  return DESKTOP_OPS.has(op);
}

/** Typing is the slow action; everything else in a batch is a few milliseconds. */
export function desktopInputTimeoutMs(
  actions: readonly DesktopAction[]
): number {
  let typed = 0;
  for (const action of actions) {
    if (action.type === "type") {
      typed += action.text.length;
    }
  }
  return (
    DESKTOP_INPUT_BASE_TIMEOUT_MS + DESKTOP_INPUT_MS_PER_TYPED_CHAR * typed
  );
}

export const ExecResultPayloadSchema = z.object({
  bytes_total: z.number(),
  duration_ms: z.number(),
  exit_code: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});
export type ExecResultPayload = z.infer<typeof ExecResultPayloadSchema>;

export const CancelResultPayloadSchema = z.object({
  cancelled: z.boolean(),
});
export type CancelResultPayload = z.infer<typeof CancelResultPayloadSchema>;

export const FilePutResultPayloadSchema = z.object({
  bytes_written: z.number(),
  /** Present on the final chunk once the client has verified the whole-file digest. */
  sha256: z.string().nullable(),
});
export type FilePutResultPayload = z.infer<typeof FilePutResultPayloadSchema>;

export const FileGetResultPayloadSchema = z.object({
  data_b64: z.string(),
  eof: z.boolean(),
  /** Whole-file digest, returned with the first chunk (offset 0) only. */
  sha256: z.string().nullable(),
  size: z.number(),
});
export type FileGetResultPayload = z.infer<typeof FileGetResultPayloadSchema>;

export const DesktopScreenshotResultPayloadSchema = z.object({
  data_b64: z.string().min(1),
  height: z.number().int().positive(),
  media_type: z.literal("image/jpeg"),
  width: z.number().int().positive(),
});
export type DesktopScreenshotResultPayload = z.infer<
  typeof DesktopScreenshotResultPayloadSchema
>;

/** The answer to `desktop_input` and `desktop_clipboard_set`. */
export const DesktopOkResultPayloadSchema = z.object({
  ok: z.literal(true),
});
export type DesktopOkResultPayload = z.infer<
  typeof DesktopOkResultPayloadSchema
>;

export const DesktopClipboardGetResultPayloadSchema = z.object({
  /** Empty when nothing owns the selection. */
  text: z.string(),
});
export type DesktopClipboardGetResultPayload = z.infer<
  typeof DesktopClipboardGetResultPayloadSchema
>;

/** The error code a daemon answers a desktop op with once its desktop has gone down. */
export const CLIENT_ERROR_DESKTOP_UNAVAILABLE = "desktop_unavailable";

export const ReplyErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ReplyError = z.infer<typeof ReplyErrorSchema>;

/**
 * A reply carries `result` or `error`, with no shared literal to discriminate on, so the two members
 * are told apart by which key is present. The relay forwards `result` verbatim and the caller narrows
 * it with the op's own payload schema, so only one side owns each op's shape.
 */
export const RawClientReplySchema = z.union([
  z.object({ error: ReplyErrorSchema, id: z.string() }),
  z.object({ id: z.string(), result: z.record(z.string(), z.unknown()) }),
]);

export type ClientReply =
  | { readonly ok: true; readonly id: string; readonly result_json: string }
  | { readonly ok: false; readonly id: string; readonly error: ReplyError };

/** Why a request could not be answered. Never thrown across RPC. */
export const RequestFailureReasonSchema = z.enum([
  "offline",
  "timeout",
  "revoked",
  "queue_full",
  "replaced",
  "bad_request",
  "forbidden",
  "interrupted",
  /** A desktop op for a machine whose last hello did not report a running desktop. */
  "desktop_unavailable",
  /** Another agent session holds the desktop, or the last person's clipboard is still being cleared. */
  "desktop_busy",
  /** A person holds the desktop; every agent op but `cancel` is refused until they hand it back. */
  "human_in_control",
]);
export type RequestFailureReason = z.infer<typeof RequestFailureReasonSchema>;

export const RequestOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result_json: z.string(),
    waited_ms: z.number(),
  }),
  z.object({
    last_seen_at: z.number().nullable(),
    message: z.string(),
    ok: z.literal(false),
    reason: RequestFailureReasonSchema,
    waited_ms: z.number(),
  }),
]);
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

/**
 * Who a relay request acts for. The server sets it from the session or the signed-in user, never
 * from anything a client sent, because the desktop lease is decided on it. An agent's `turn_id` is
 * null outside a turn, for example on the file-download route.
 */
export const RelayPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    session_id: z.string(),
    turn_id: z.string().nullable(),
  }),
  z.object({ kind: z.literal("human"), user_id: z.string() }),
]);
export type RelayPrincipal = z.infer<typeof RelayPrincipalSchema>;

/** What `request()` needs from its caller so the relay can refuse another tenant's computer. */
export interface RelayRequestInput {
  op_json: string;
  principal: RelayPrincipal;
  tenant_id: string;
  timeout_ms: number;
}

/** The answer to taking the human lease. */
export type TakeHumanLeaseOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `desktop_busy`: the last person's clipboard could not be cleared yet, so nobody takes over. */
      readonly reason:
        | "desktop_unavailable"
        | "revoked"
        | "forbidden"
        | "desktop_busy";
      readonly message: string;
    };

/** Who drives the desktop right now, as the relay sees it. `expires_at` is epoch milliseconds. */
export const DesktopControlStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("agent"), session_id: z.string() }),
  z.object({
    expires_at: z.number(),
    kind: z.literal("human"),
    user_id: z.string(),
  }),
  z.object({ kind: z.literal("clearing") }),
]);
export type DesktopControlState = z.infer<typeof DesktopControlStateSchema>;

export const ComputerRelayStatusSchema = z.object({
  connected: z.boolean(),
  desktop_control: DesktopControlStateSchema,
  generation: z.number(),
  hello: HelloMessageSchema.nullable(),
  in_flight_exec: z.number(),
  last_seen_at: z.number().nullable(),
  pending: z.number(),
  queued: z.number(),
  revoked: z.boolean(),
});
export type ComputerRelayStatus = z.infer<typeof ComputerRelayStatusSchema>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the caller treats the frame as having no value.
  }
}

/**
 * What arrived on the socket. A frame that claims to be a hello is never mistaken for a reply, even
 * when this version cannot read it, so an unknown `protocol_version` is ignored rather than settling
 * some request by accident.
 */
export type ClientFrame =
  | { readonly kind: "hello"; readonly hello: HelloMessage }
  | { readonly kind: "unreadable_hello" }
  | { readonly kind: "reply"; readonly reply: ClientReply }
  | { readonly kind: "ignore" };

export function classifyClientFrame(raw: string): ClientFrame {
  const parsed = parseJson(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    parsed.type === "hello"
  ) {
    const hello = HelloMessageSchema.safeParse(parsed);
    return hello.success
      ? { hello: hello.data, kind: "hello" }
      : { kind: "unreadable_hello" };
  }
  const reply = RawClientReplySchema.safeParse(parsed);
  if (!reply.success) {
    return { kind: "ignore" };
  }
  if ("error" in reply.data) {
    return {
      kind: "reply",
      reply: { error: reply.data.error, id: reply.data.id, ok: false },
    };
  }
  return {
    kind: "reply",
    reply: {
      id: reply.data.id,
      ok: true,
      result_json: JSON.stringify(reply.data.result),
    },
  };
}

export function parseExecResult(json: string): ExecResultPayload | undefined {
  const parsed = ExecResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseFilePutResult(
  json: string
): FilePutResultPayload | undefined {
  const parsed = FilePutResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseFileGetResult(
  json: string
): FileGetResultPayload | undefined {
  const parsed = FileGetResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseDesktopScreenshotResult(
  json: string
): DesktopScreenshotResultPayload | undefined {
  const parsed = DesktopScreenshotResultPayloadSchema.safeParse(
    parseJson(json)
  );
  return parsed.success ? parsed.data : undefined;
}

export function parseDesktopOkResult(
  json: string
): DesktopOkResultPayload | undefined {
  const parsed = DesktopOkResultPayloadSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : undefined;
}

export function parseDesktopClipboardGetResult(
  json: string
): DesktopClipboardGetResultPayload | undefined {
  const parsed = DesktopClipboardGetResultPayloadSchema.safeParse(
    parseJson(json)
  );
  return parsed.success ? parsed.data : undefined;
}

export function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${String(seconds)} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)} minutes`;
  }
  return `${String(Math.round(minutes / 60))} hours`;
}

export function offlineMessage({
  computerName,
  lastSeenAt,
  now,
}: {
  computerName: string;
  lastSeenAt: number | null;
  now: number;
}): string {
  if (lastSeenAt === null) {
    return `Computer ${computerName} is offline (never connected)`;
  }
  return `Computer ${computerName} is offline (last seen ${describeAge(now - lastSeenAt)} ago)`;
}
