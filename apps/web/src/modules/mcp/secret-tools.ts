import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logActivity } from "#/modules/activity/service";
import {
  TOOL_OUTPUT_MAX_BYTES,
  truncateText,
  withTruncationNote,
} from "#/modules/computer/output";
import { getAttachmentInWorkspace } from "#/modules/messaging/attachment-service";
import { hostMatches, isPrivateHost } from "#/modules/secrets/hosts";
import {
  listSecretsForAgent,
  markSecretUsed,
  type ResolvedSecret,
  resolveSecretForAgent,
} from "#/modules/secrets/service";
import { fail, json } from "./format";
import type { McpToolContext } from "./tools";

/**
 * The credential broker an agent talks to. `list_secrets` says what it holds;
 * `http_request` spends one without ever showing it.
 *
 * The agent names a secret, this file resolves it (`modules/secrets/service`),
 * checks the target against that secret's own allowlist (`modules/secrets/hosts`)
 * and injects the value into one request header. The value is never an input,
 * never an output, never an activity row and never part of an error message -
 * which is why every string that leaves here goes through `redactSecret` first.
 *
 * Nothing here decides *which* hosts are allowed or *whether* a grant exists;
 * both are forge 1's, and asking them twice in two places is how the two
 * answers drift apart.
 *
 * The same shape holds for the bytes an agent sends. A `body` it composes is a
 * tool-call argument and is capped as one, which puts any real media file out
 * of reach - an audio recording on its way to a transcription API is the case
 * this exists for. `attachmentId` is the way past that cap: the file streams
 * from R2 to the upstream without the agent ever holding it, and whether the
 * agent may send that file at all is `getAttachmentInWorkspace`'s answer - the
 * same parent chain the messaging tools resolve, asked once here rather than
 * reimplemented.
 */

/**
 * A request body an agent composes: generous for JSON, bounded for D1's sake,
 * since it arrives as a tool-call argument and is stored as one. A file too big
 * for this cap is never composed at all - it is sent by `attachmentId`, which
 * streams from storage and never becomes an argument.
 */
const HTTP_BODY_MAX_LENGTH = 100_000;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Methods that may not carry a body. Checked here rather than left to `fetch`,
 * because the two runtimes disagree about when they complain: workerd throws
 * from `fetch`, Bun's `Request` constructor accepts it and only `fetch` rejects
 * it. Either way the throw would land in the catch below and be recorded as a
 * request that failed - a use of the secret that never left the process.
 */
const METHODS_WITHOUT_BODY = new Set<string>(["GET"]);

/**
 * How much of a response we are willing to pull into memory.
 *
 * Twice `TOOL_OUTPUT_MAX_BYTES`, because everything past the cap is truncated
 * away anyway and the doubling is headroom for a multi-byte character at the
 * cut. Unlike `computer_exec`, the thing producing this output is not ours: a
 * host an agent can be talked into naming could otherwise stream until the
 * isolate dies, so the body is read in chunks and the reader is cancelled the
 * moment we have enough.
 */
const RESPONSE_READ_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES * 2;

/**
 * Deliberately says "not read past" rather than "was larger than": the read
 * also stops on a body that ends exactly on the cap, and claiming there is
 * more when there is not would send an agent paging after nothing.
 */
/**
 * How many hops the no-secret path will follow. Redirects are followed by hand
 * rather than by `fetch` so every hop is checked; five is the conventional cap
 * and is well past what a real API uses.
 */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 307 and 308 keep the method and body; the older three turn into a GET. */
const METHOD_PRESERVING_REDIRECTS = new Set([307, 308]);

/**
 * Headers a redirect to another host must not carry. The agent may set its own
 * `Authorization` on the no-secret path, and replaying it to whatever a public
 * host names is the same leak the secret path holds redirects back for. This is
 * what browsers do on a cross-origin redirect.
 */
const CROSS_HOST_STRIPPED_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

const CAPPED_NOTE = `[truncated: the response was not read past ${RESPONSE_READ_MAX_BYTES} bytes, and only the first ${TOOL_OUTPUT_MAX_BYTES} of those are shown]`;

/**
 * What comes back to the agent. A deliberately short list: enough to parse the
 * response (`content-type`), to act on a redirect this tool refuses to follow
 * (`location`) and to back off (`retry-after`). The request's own headers are
 * never echoed - one of them is the secret.
 */
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "date",
  "etag",
  "last-modified",
  "location",
  "retry-after",
] as const;

// --- redaction ---------------------------------------------------------------

/**
 * Replaces every literal occurrence of a secret's value with `[REDACTED:NAME]`.
 *
 * Pure, and applied to *everything* that leaves this module: the response body,
 * each returned header, and the message of a thrown fetch error. An upstream
 * that echoes the key back - a validation error quoting the header it did not
 * like is the common one - must not put it in the transcript, the runner's
 * events or the activity feed.
 *
 * It must run **before** truncation, never after: a value straddling the cut
 * would otherwise survive as two halves, one of them in the output.
 *
 * Best-effort by construction, and the allowlist is the real control: this
 * catches the literal value, not a base64'd or percent-encoded one.
 */
export const redactSecret = (
  text: string,
  secret: Pick<ResolvedSecret, "name" | "value"> | null
): string => {
  if (!secret || secret.value.length === 0) {
    // `replaceAll("", x)` splices the replacement between every character.
    return text;
  }
  return text.replaceAll(secret.value, `[REDACTED:${secret.name}]`);
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- the target --------------------------------------------------------------

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * `https:` only, and never somebody's own network.
 *
 * `modules/browser/rules.ts` guards the browser tools and looks similar, but it
 * accepts `http:` and keeps its address check private to that file. The
 * exported guard is `isPrivateHost`, which forge 1 wrote for exactly this
 * caller: on the path where no secret is named there is no allowlist to check
 * against, and the request is still a fetch from our network.
 *
 * No DNS is resolved - a Worker cannot - so a public name pointed at 127.0.0.1
 * still passes. That is the same limitation both other guards document.
 */
export const checkUrl = (raw: string): UrlCheck => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: `"${raw}" is not a valid URL. Pass an absolute one, e.g. https://api.example.com/v1/things.`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `http_request only makes https requests, and "${raw}" is ${url.protocol}//. Use https.`,
    };
  }
  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason: `${url.hostname} is a private or loopback address, which http_request will not reach.`,
    };
  }
  return { ok: true, url };
};

/**
 * The same sentence for all three misses - no such secret, another workspace's,
 * and one granted to a different agent. A message that told them apart would
 * let an agent enumerate which names exist in a deployment it cannot see.
 */
const noSuchSecret = (name: string): string =>
  `No secret named ${name} is granted to you. Use list_secrets to see what you hold.`;

const hostRefusal = (secret: ResolvedSecret, hostname: string): string =>
  `${secret.name} may only be sent to ${secret.allowedHosts.join(", ")}, not ${hostname}. Nothing was requested.`;

type SecretLookup =
  | { ok: true; secret: ResolvedSecret | null }
  | { ok: false; reason: string };

/**
 * The grant and the allowlist, or the sentence that refuses. Naming no secret
 * is not a miss: it resolves to `null`, which is the unauthenticated path.
 *
 * Both checks happen here so that neither can be skipped by a later branch, and
 * both happen before anything is sent: a refused host must not become a request
 * that happened to fail.
 */
const resolveSecret = async (
  ctx: McpToolContext,
  name: string | undefined,
  hostname: string
): Promise<SecretLookup> => {
  if (name === undefined) {
    return { ok: true, secret: null };
  }
  const secret = await resolveSecretForAgent(ctx.db, ctx.env, {
    agentId: ctx.agent.id,
    name,
    workspaceId: ctx.workspace.id,
  });
  if (!secret) {
    return { ok: false, reason: noSuchSecret(name) };
  }
  if (!hostMatches(hostname, secret.allowedHosts)) {
    return { ok: false, reason: hostRefusal(secret, hostname) };
  }
  return { ok: true, secret };
};

// --- the file ----------------------------------------------------------------

/**
 * A stored attachment, opened and ready to stream. The bytes go from R2 to the
 * upstream: they are never read into a string here, so nothing about them can
 * reach the transcript, the tool's answer or the activity feed.
 *
 * `id` is carried along for the audit row - which file left the workspace is
 * the other question that trail is read for - and `size` for the outbound
 * length.
 */
interface AttachmentBody {
  id: string;
  mime: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

type AttachmentLookup =
  | { ok: true; file: AttachmentBody | null }
  | { ok: false; reason: string };

/**
 * One sentence for an id that never existed and for another workspace's, for
 * the reason `noSuchSecret` gives: `getAttachmentInWorkspace` answers
 * `undefined` to both, and a message that told them apart would say whether an
 * id exists in a workspace the caller cannot see.
 */
const noSuchAttachment = (id: string): string =>
  `No attachment with id ${id} is visible to you. Attachment ids come from the attachments on messages you read.`;

/**
 * The file, or the sentence that refuses. Naming no attachment is not a miss:
 * it resolves to `null`, and the body is whatever `body` held.
 */
const resolveAttachment = async (
  ctx: McpToolContext,
  id: string | undefined
): Promise<AttachmentLookup> => {
  if (id === undefined) {
    return { file: null, ok: true };
  }
  const attachment = await getAttachmentInWorkspace(
    ctx.db,
    ctx.workspace.id,
    id
  );
  if (!attachment) {
    return { ok: false, reason: noSuchAttachment(id) };
  }

  const object = await ctx.env.ATTACHMENTS.get(attachment.r2Key);
  if (!object) {
    // The row outlived its object. A refusal rather than an empty body: an
    // upstream that bills per request should not be paid to transcribe nothing,
    // and an agent told the file is gone can say so instead of retrying.
    return {
      ok: false,
      reason: `${attachment.filename} is recorded but its stored bytes are gone, so nothing was requested.`,
    };
  }
  return {
    file: {
      id: attachment.id,
      mime: attachment.mime,
      size: attachment.size,
      stream: object.body,
    },
    ok: true,
  };
};

/**
 * The stream that goes on the wire, with a `Content-Length` promised from the
 * size the workspace recorded.
 *
 * It has to be promised through `FixedLengthStream` and not through a header,
 * because workerd derives `Content-Length` from the body's data source and
 * drops whatever a caller wrote into `Headers`. Measured against a local
 * workerd rather than assumed: a deliberately wrong `Content-Length` header
 * was overwritten with the real length, and a plain `ReadableStream` went out
 * as `Transfer-Encoding: chunked` however the header was set. Only a
 * `FixedLengthStream` or an already-fixed-length value gets a length, which is
 * what the runtime API docs promise as well.
 *
 * R2's own body did carry a length unwrapped under the local runtime, so the
 * wrap is not what makes this work today. It is still made explicitly: local
 * R2 is miniflare's and not the real thing, and a length nothing documents is
 * a length that can stop appearing. An upstream that requires one -
 * S3-compatible APIs do - would refuse a chunked body outright.
 *
 * A stream that then does not deliver exactly `size` bytes tears the connection
 * down, and the tool reports a failed request. That is the honest outcome: the
 * D1 row and the R2 object disagreeing is not something to paper over by
 * sending a different number of bytes than the workspace recorded.
 *
 * `FixedLengthStream` is a workerd global and `bun test` has none, so the tests
 * see the raw stream. That changes the framing on the wire, not the bytes, and
 * the bytes are what those tests assert.
 */
const outboundBody = (file: AttachmentBody): BodyInit => {
  // biome-ignore lint/correctness/noUndeclaredVariables: FixedLengthStream is a Workers runtime global
  if (typeof FixedLengthStream === "undefined") {
    return file.stream;
  }
  // biome-ignore lint/correctness/noUndeclaredVariables: FixedLengthStream is a Workers runtime global
  return file.stream.pipeThrough(new FixedLengthStream(file.size));
};

// --- the request -------------------------------------------------------------

/**
 * The agent's headers, then the secret's on top. `Headers.set` matches names
 * case-insensitively, so an agent-supplied `authorization` is replaced by the
 * secret's `Authorization` rather than joining it - the agent cannot smuggle a
 * header past a check that spelled it differently.
 *
 * A file's stored mime fills in a `Content-Type` the agent did not set, and
 * loses to one it did: we recorded that type at upload, but the agent is the
 * one that knows what this upstream wants. `Headers.has` folds case too, so a
 * `Content-Type` written any way at all still wins.
 *
 * Throws on a malformed name or value, which the caller turns into a tool
 * error; header-splitting attempts are refused by `Headers` itself.
 */
const requestHeaders = (
  supplied: Record<string, string> | undefined,
  secret: ResolvedSecret | null,
  file: AttachmentBody | null
): Headers => {
  const headers = new Headers(supplied);
  if (file && !headers.has("content-type")) {
    headers.set("content-type", file.mime);
  }
  if (secret) {
    headers.set(secret.header, `${secret.headerPrefix}${secret.value}`);
  }
  return headers;
};

const responseHeaders = (
  response: Response,
  secret: ResolvedSecret | null
): Record<string, string> => {
  const subset: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      subset[name] = redactSecret(value, secret);
    }
  }
  return subset;
};

interface CappedBody {
  /** True when the upstream had more to give and we stopped asking. */
  capped: boolean;
  text: string;
}

/**
 * The start of a response body, and nothing more. Never buffers the whole
 * thing: it reads chunk by chunk, stops once past `RESPONSE_READ_MAX_BYTES`,
 * and cancels the stream so the connection closes instead of draining.
 */
const readCapped = async (response: Response): Promise<CappedBody> => {
  if (!response.body) {
    return { capped: false, text: "" };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let read = 0;
  let capped = false;

  try {
    while (read < RESPONSE_READ_MAX_BYTES) {
      // biome-ignore lint/performance/noAwaitInLoops: chunks arrive in order
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      read += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      capped = read >= RESPONSE_READ_MAX_BYTES;
    }
    chunks.push(decoder.decode());
  } finally {
    // Whether we stopped early or the upstream ended, we are done with it.
    await reader.cancel().catch(() => {
      // A stream that is already closed cannot be cancelled, which is fine.
    });
  }

  return { capped, text: chunks.join("") };
};

interface Attempt {
  /** A string the agent composed, or a stored file's stream. */
  body: BodyInit | undefined;
  headers: Headers;
  method: string;
  url: URL;
}

interface ChainResult {
  /** How many redirects were followed. */
  hops: number;
  /** Set when a hop was refused: the chain stopped, and this says why. */
  refusal?: string;
  /** The last response actually received, refused chain or not. */
  response: Response;
  /** Where that response came from, which is what the audit row names. */
  url: URL;
}

const resolveLocation = (location: string, from: URL): UrlCheck => {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return {
      ok: false,
      reason: `${from.hostname} redirected to "${location}", which is not a URL that can be followed.`,
    };
  }
  const checked = checkUrl(next.href);
  return checked.ok
    ? checked
    : {
        ok: false,
        reason: `${from.hostname} redirected to ${next.hostname}, and the redirect was not followed. ${checked.reason}`,
      };
};

/**
 * What the next hop looks like. A cross-host hop loses the headers that
 * authenticate, and anything but a 307/308 becomes a bodyless GET - the rule
 * `fetch` itself applies, restated here because we are doing its job.
 */
const afterRedirect = (status: number, previous: Attempt, to: URL): Attempt => {
  const headers = new Headers(previous.headers);
  if (previous.url.hostname !== to.hostname) {
    for (const name of CROSS_HOST_STRIPPED_HEADERS) {
      headers.delete(name);
    }
  }
  return METHOD_PRESERVING_REDIRECTS.has(status)
    ? { ...previous, headers, url: to }
    : { body: undefined, headers, method: "GET", url: to };
};

const fetchOnce = (attempt: Attempt): Promise<Response> =>
  fetch(attempt.url.href, {
    body: attempt.body,
    headers: attempt.headers,
    method: attempt.method,
    // Unconditional. With a secret it is the whole point - `fetch` replays the
    // Authorization header across a redirect, so a 3xx from an allowlisted host
    // would hand the key to the redirect target. Without one it is what lets
    // the loop below check each hop, which `fetch` following redirects itself
    // would never give us: only the first URL passes `checkUrl`, and a public
    // host redirecting to 169.254.169.254 would walk straight through the
    // guard that exists to refuse exactly that.
    redirect: "manual",
  });

/**
 * One request, then - only when the chain may be followed at all - up to
 * `MAX_REDIRECTS` hops, each checked before it is made.
 *
 * A secret-carrying request never follows anything: its 3xx goes back to the
 * agent as it is, and the agent decides. Nor does a request whose body is a
 * stored file, for a different reason: a 307 keeps the body, and the R2 stream
 * the first hop consumed cannot be read a second time. Handing the 3xx back is
 * an answer the agent can act on; replaying a locked stream is an error about
 * our own plumbing.
 */
const send = async (
  start: Attempt,
  followRedirects: boolean
): Promise<ChainResult> => {
  let attempt = start;
  let hops = 0;
  let response = await fetchOnce(attempt);

  while (followRedirects && REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("location");
    if (location === null) {
      break;
    }
    if (hops === MAX_REDIRECTS) {
      return {
        hops,
        refusal: `${start.url.hostname} redirected more than ${MAX_REDIRECTS} times; the chain was stopped.`,
        response,
        url: attempt.url,
      };
    }
    const next = resolveLocation(location, attempt.url);
    if (!next.ok) {
      return { hops, refusal: next.reason, response, url: attempt.url };
    }
    attempt = afterRedirect(response.status, attempt, next.url);
    hops += 1;
    // biome-ignore lint/performance/noAwaitInLoops: hops are sequential by nature
    response = await fetchOnce(attempt);
  }

  return { hops, response, url: attempt.url };
};

/**
 * The audit trail: which agent used which key, where, and how it went.
 *
 * `detail` carries no headers and no body - one header is the secret and the
 * body is whatever an upstream chose to send us - and the path is
 * `url.pathname` alone, because a query string is where a key ends up when
 * somebody ignores the header-only rule. A file that was sent is named by id
 * and by nothing else, for the same reason: which file left the workspace is
 * the second question this trail answers, and its contents are not.
 *
 * A request that was actually made counts as a use even when it failed
 * mid-flight: the value had already been handed to the runtime, and an audit
 * with a hole exactly where a key was sent is not an audit. A *refused* call -
 * a bad URL, an ungranted name, a host that did not match - never reaches here.
 */
const record = async (
  ctx: McpToolContext,
  url: URL,
  method: string,
  secret: ResolvedSecret | null,
  file: AttachmentBody | null,
  outcome: number | "failed",
  hops = 0
): Promise<void> => {
  await logActivity(ctx.db, {
    agentId: ctx.agent.id,
    detail: {
      host: url.hostname,
      // The method the agent asked for, not what a 302 turned it into: that is
      // what someone reading the feed is looking for.
      method,
      path: url.pathname,
      secret: secret === null ? null : secret.name,
      status: outcome,
      // Both only when they apply, so an ordinary row stays exactly as it was -
      // and a chain, or a file, is what someone reads this trail to find.
      ...(file ? { attachment: file.id } : {}),
      ...(hops > 0 ? { hops } : {}),
    },
    kind: "http.request",
    summary: `${method} ${url.hostname}${url.pathname} → ${outcome}`,
  });
  if (secret) {
    await markSecretUsed(ctx.db, secret.id);
  }
};

export interface HttpRequestInput {
  attachmentId?: string;
  body?: string;
  headers?: Record<string, string>;
  method?: (typeof HTTP_METHODS)[number];
  secret?: string;
  url: string;
}

const perform = async (
  ctx: McpToolContext,
  url: URL,
  input: HttpRequestInput,
  secret: ResolvedSecret | null,
  file: AttachmentBody | null
): Promise<CallToolResult> => {
  const method = input.method ?? "GET";

  let headers: Headers;
  try {
    headers = requestHeaders(input.headers, secret, file);
  } catch (error) {
    return fail(
      `Those headers are not valid: ${redactSecret(messageOf(error), secret)}`
    );
  }

  let chain: ChainResult;
  try {
    chain = await send(
      { body: file ? outboundBody(file) : input.body, headers, method, url },
      secret === null && file === null
    );
  } catch (error) {
    await record(ctx, url, method, secret, file, "failed");
    return fail(
      `The request to ${url.hostname} failed: ${redactSecret(messageOf(error), secret)}`
    );
  }

  // A refused hop still means the requests before it were made, so the chain
  // is recorded before the refusal goes back.
  if (chain.refusal) {
    await record(
      ctx,
      chain.url,
      method,
      secret,
      file,
      chain.response.status,
      chain.hops
    );
    return fail(chain.refusal);
  }

  let answer: {
    body: string;
    capped: boolean;
    headers: Record<string, string>;
    status: number;
  };
  try {
    const read = await readCapped(chain.response);
    answer = {
      body: read.text,
      capped: read.capped,
      headers: responseHeaders(chain.response, secret),
      status: chain.response.status,
    };
  } catch (error) {
    await record(ctx, chain.url, method, secret, file, "failed", chain.hops);
    return fail(
      `The request to ${chain.url.hostname} failed: ${redactSecret(messageOf(error), secret)}`
    );
  }

  // Redact, then truncate. The other order leaves half a key at the cut.
  const body = truncateText(
    redactSecret(answer.body, secret),
    TOOL_OUTPUT_MAX_BYTES
  );
  await record(ctx, chain.url, method, secret, file, answer.status, chain.hops);

  return json({
    // When the read was capped, `truncateText`'s note would name the bytes we
    // pulled as though they were the whole response. They are not, and the
    // agent has to know the rest was never fetched rather than merely cut.
    body: answer.capped
      ? `${body.text}\n${CAPPED_NOTE}`
      : withTruncationNote(body),
    headers: answer.headers,
    status: answer.status,
    truncated: body.truncated || answer.capped,
  });
};

export const httpRequest = async (
  ctx: McpToolContext,
  input: HttpRequestInput
): Promise<CallToolResult> => {
  const target = checkUrl(input.url);
  if (!target.ok) {
    return fail(target.reason);
  }

  // Two ways to say what the body is, and deliberately no precedence between
  // them. A silent winner would send the composed string when the agent meant
  // the recording, or the recording when it meant the string, and the agent
  // would read a confusing upstream error instead of its own mistake.
  const suppliedBody = input.body !== undefined;
  const suppliedFile = input.attachmentId !== undefined;
  if (suppliedBody && suppliedFile) {
    return fail(
      "Pass either `body` or `attachmentId`, not both: `body` sends what you composed, `attachmentId` sends a stored file's bytes."
    );
  }

  const method = input.method ?? "GET";
  // Alongside the URL rules, and for the same reason: a refusal here writes no
  // activity row and bumps no `last_used_at`, whereas letting `fetch` throw
  // would record a use of a key that never left the process.
  if ((suppliedBody || suppliedFile) && METHODS_WITHOUT_BODY.has(method)) {
    return fail(
      `A ${method} request cannot have a body. Drop \`${suppliedFile ? "attachmentId" : "body"}\`, or use POST, PUT or PATCH.`
    );
  }

  const granted = await resolveSecret(ctx, input.secret, target.url.hostname);
  if (!granted.ok) {
    return fail(granted.reason);
  }

  // Last of the checks, because it is the only one that opens an R2 object: a
  // request the allowlist was always going to refuse never touches the file.
  const found = await resolveAttachment(ctx, input.attachmentId);
  if (!found.ok) {
    return fail(found.reason);
  }

  return await perform(ctx, target.url, input, granted.secret, found.file);
};

// --- registration ------------------------------------------------------------

const SECRETS_INTRO =
  "Workspace secrets are API keys someone granted you. You never see a value: you name one and it is injected into the request for you.";

export const registerSecretTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "list_secrets",
    {
      description: `${SECRETS_INTRO} List the secrets granted to you, with what each is for and the hosts it may be sent to. Pass a name as \`secret\` to http_request to use one.`,
      inputSchema: {},
      title: "List your secrets",
    },
    async () =>
      json({
        secrets: await listSecretsForAgent(
          ctx.db,
          ctx.workspace.id,
          ctx.agent.id
        ),
      })
  );

  server.registerTool(
    "http_request",
    {
      description: `${SECRETS_INTRO} Make an https request and get back the status, a few response headers and the body. Name a granted secret in \`secret\` and its key is added as a request header - only for the hosts that secret allows, and only as a header, never in the URL or the body. Without \`secret\` this is a plain https request to any public host. To send a file that already exists - a recording someone attached to a message, say - pass its id as \`attachmentId\` instead of \`body\`: the bytes stream from storage to the upstream, so a file far larger than anything you could compose can be sent, and you never hold it. Private and loopback addresses are refused, long response bodies are truncated with a note, and redirects are followed only to public https hosts, at most 5 hops - when a secret or an attachment is attached they are not followed at all but handed back to you.`,
      inputSchema: {
        attachmentId: z
          .string()
          .optional()
          .describe(
            "Send a stored file as the request body, by the id of an attachment in your workspace - for sending a file, not for composing one. Ids come from the attachments on messages you read. Its stored type becomes the content-type unless you set one in `headers`. Cannot be combined with `body`."
          ),
        body: z
          .string()
          .max(HTTP_BODY_MAX_LENGTH)
          .optional()
          .describe(
            "The request body, sent as-is. Set its content-type in `headers`. For a stored file, use `attachmentId` instead."
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Request headers. A header the secret uses is ignored - the secret wins."
          ),
        method: z
          .enum(HTTP_METHODS)
          .optional()
          .describe("Defaults to GET (case-sensitive)."),
        secret: z
          .string()
          .optional()
          .describe(
            'The name of a secret granted to you, e.g. "DEEPGRAM_API_KEY". See list_secrets.'
          ),
        url: z
          .string()
          .describe("An absolute https URL, e.g. https://api.example.com/v1."),
      },
      title: "Make an https request",
    },
    (input) => httpRequest(ctx, input)
  );
};
