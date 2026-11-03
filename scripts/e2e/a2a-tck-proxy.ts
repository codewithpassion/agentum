// A header-adding proxy in front of one published agent, for the official
// A2A TCK. The TCK's transport clients send no Authorization header, and the
// server answers every `/a2a` call except the card with 401 without one. The
// proxy adds the connection's key to each request that carries none, serves
// the card at the host root where the TCK looks for it, and points the card's
// interfaces at itself so the TCK's calls come back through it. The server is
// not given an unauthenticated mode, and the TCK runs unmodified.
//
// Two rewrites of a message, both about what the TCK assumes of its agent:
//
// - The TCK's scenarios say what the agent under test does for a message id
//   prefix (`tck-input-required` waits for input). A Agentum agent is
//   driven by its prompt, so `promptFor` maps a prefix to the text the
//   dev-only `faux` model turns into that behaviour. The list is
//   `TCK_PROMPTS` in a2a-tck-prompts.ts, and only the first text part of a
//   `SendMessage` changes.
// - The TCK sends one message id for every test that needs a task and expects
//   a new task each time. A server may treat a repeated message id as a retry
//   (spec 3.3.1, "MAY be idempotent"), and ours does, so each send gets a
//   message id of its own.
//
// It listens on 127.0.0.1 only, because it holds the key.

import { serve } from "bun";

export interface TckProxyOptions {
  /** Port the proxy listens on. */
  port: number;
  /** Maps a message id to the prompt for the faux model, or null to leave the text alone. */
  promptFor?: (messageId: string) => string | null;
  /** The published agent. */
  publicId: string;
  /** The key of the connection the proxy speaks as. */
  token: string;
  /** The deployment's origin, `http://localhost:<port>`. */
  upstream: string;
}

export interface TckProxy {
  /** What the TCK is given as `--sut-host`. */
  host: string;
  /** Every request seen: method, path, status. */
  seen: { method: string; path: string; status: number }[];
  stop: () => void;
}

const HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
];

let sent = 0;

/** The text of a `SendMessage` body rewritten for its message id, when `promptFor` has one. */
export const rewriteMessage = (
  body: unknown,
  promptFor: (messageId: string) => string | null
): unknown => {
  if (typeof body !== "object" || body === null) {
    return body;
  }
  const holder = body as {
    message?: { messageId?: unknown; parts?: unknown };
    params?: { message?: { messageId?: unknown; parts?: unknown } };
  };
  const message = holder.params?.message ?? holder.message;
  if (!message || typeof message.messageId !== "string") {
    return body;
  }
  const prompt = promptFor(message.messageId);
  sent += 1;
  message.messageId = `${message.messageId}-p${sent}`;
  if (prompt === null || !Array.isArray(message.parts)) {
    return body;
  }
  message.parts = message.parts.map((part: unknown, index: number) =>
    index === 0 && typeof part === "object" && part !== null && "text" in part
      ? { ...(part as object), text: prompt }
      : part
  );
  return body;
};

/** The request's headers without the hop-by-hop ones, plus the key when the caller sent no credential. */
const upstreamHeaders = (request: Request, token: string | null): Headers => {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!HOP_HEADERS.includes(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  if (token !== null && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
};

/** The request body, with a JSON message rewritten for the faux model and given a message id of its own. */
const upstreamBody = async (
  request: Request,
  promptFor: (messageId: string) => string | null
): Promise<BodyInit | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return;
  }
  const text = await request.text();
  if (!text.startsWith("{")) {
    return text;
  }
  try {
    return JSON.stringify(rewriteMessage(JSON.parse(text), promptFor));
  } catch {
    return text;
  }
};

/** The card with every interface URL moved from the deployment to the proxy. */
const cardAtProxy = async (
  response: Response,
  headers: Headers,
  upstream: string,
  base: string
): Promise<Response> => {
  const card = (await response.json()) as {
    supportedInterfaces?: { url: string }[];
  };
  for (const entry of card.supportedInterfaces ?? []) {
    entry.url = entry.url.replace(upstream, base);
  }
  return Response.json(card, { headers, status: 200 });
};

export const startTckProxy = (options: TckProxyOptions): TckProxy => {
  const { port, promptFor, publicId, token, upstream } = options;
  const seen: TckProxy["seen"] = [];
  const base = `http://127.0.0.1:${port}`;
  const cardPath = `/a2a/${publicId}/.well-known/agent-card.json`;

  const server = serve({
    async fetch(request) {
      const url = new URL(request.url);
      const isCard =
        url.pathname === "/.well-known/agent-card.json" ||
        url.pathname === cardPath;
      const response = await fetch(
        `${upstream}${isCard ? cardPath : url.pathname}${url.search}`,
        {
          body: await upstreamBody(request, promptFor ?? (() => null)),
          headers: upstreamHeaders(request, isCard ? null : token),
          method: request.method,
          redirect: "manual",
          signal: request.signal,
        }
      );
      seen.push({
        method: request.method,
        path: url.pathname,
        status: response.status,
      });
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      if (isCard && response.ok) {
        return await cardAtProxy(response, headers, upstream, base);
      }
      return new Response(response.body, { headers, status: response.status });
    },
    // Only this machine reaches it: it adds a key to what it forwards.
    hostname: "127.0.0.1",
    // SSE streams stay open as long as the TCK reads them.
    idleTimeout: 0,
    port,
  });

  return {
    host: base,
    seen,
    stop: () => server.stop(true),
  };
};
