/**
 * What the platform does to a request that leaves a skill script's isolate.
 * The isolate's `globalOutbound` is `SecretsOutbound`, which calls this with
 * the rules that apply to the request's host. A host with no rule passes
 * through as it came. A host with rules gets each rule's header added here,
 * outside the isolate, so the script never holds the value and cannot read
 * the header it caused.
 */
import type { ProxyMatch } from "@repo/services/secrets";
import { scrubBody, scrubText } from "@repo/services/secrets/scrub";

const BAD_GATEWAY = 502;
const FORBIDDEN = 403;
const BODYLESS = new Set([204, 205, 304]);
/** Headers whose value could echo a credential back to the script. */
const SCRUBBED_RESPONSE_HEADERS = ["location", "www-authenticate"];

export interface OutboundDeps {
  /** Records that credentials were added, names and host only. May reject: the call goes on. */
  announce: (host: string, names: string[]) => Promise<void>;
  /** Sends the request on. */
  fetch: (request: Request) => Promise<Response>;
  /** Writes a line to the Worker log. Never given a value. */
  log: (line: string) => void;
  /** The rules that apply to a request to `host`. */
  matches: (host: string) => Promise<ProxyMatch[]>;
}

const refuse = (status: number, message: string): Response =>
  new Response(message, { status });

/** The answer with the credential taken out of its body and the headers that can carry it. */
const scrubbed = async (
  response: Response,
  matches: readonly ProxyMatch[]
): Promise<Response> => {
  const headers = new Headers(response.headers);
  for (const name of SCRUBBED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) {
      headers.set(name, scrubText(value, matches));
    }
  }
  if (BODYLESS.has(response.status) || response.body === null) {
    return new Response(null, { headers, status: response.status });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = scrubBody(bytes, headers.get("content-type"), matches);
  // The length of the scrubbed body is recomputed by the runtime.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { headers, status: response.status });
};

export const outboundFetch = async (
  request: Request,
  deps: OutboundDeps
): Promise<Response> => {
  const url = new URL(request.url);
  let matches: ProxyMatch[];
  try {
    matches = await deps.matches(url.hostname);
  } catch {
    // Fail closed: a request that should carry a credential must not go out bare.
    deps.log("outbound: the secret rules could not be read");
    return refuse(
      BAD_GATEWAY,
      "The platform could not read this agent's secrets."
    );
  }
  if (matches.length === 0) {
    return await deps.fetch(request);
  }
  if (url.protocol !== "https:") {
    return refuse(
      FORBIDDEN,
      "This agent has a credential for that host, and it is added to https requests only."
    );
  }
  const headers = new Headers(request.headers);
  for (const match of matches) {
    headers.set(match.header, match.headerValue);
  }
  try {
    await deps.announce(url.hostname, [
      ...new Set(matches.map((match) => match.name)),
    ]);
  } catch {
    deps.log("outbound: recording the event failed");
  }
  // A redirect is handed back to the script, which asks again and so comes
  // through here again: the header is never sent to the host it points to.
  const response = await deps.fetch(
    new Request(request, { headers, redirect: "manual" })
  );
  return await scrubbed(response, matches);
};
