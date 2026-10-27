/**
 * What the platform does to a request that leaves an app's server part. The
 * Worker's `globalOutbound` is `AppOutbound`, which calls this. Only hosts a
 * person approved get through, read on every request because the loader
 * config is cached per version and approvals land after it loads. An allowed
 * request then goes through the same placeholder filling as `SecretsOutbound`.
 */
import { outboundFetch } from "../secrets-outbound-core.ts";
import type { AppGrantsPort } from "./ports.ts";
import type { AppOutboundProps } from "./types.ts";

const FORBIDDEN = 403;
const BAD_GATEWAY = 502;

export interface AppOutboundDeps {
  /** Sends the request on. */
  fetch: (request: Request) => Promise<Response>;
  grants: AppGrantsPort;
  /** Writes a line to the Worker log. Never given a value. */
  log: (line: string) => void;
}

const refuse = (status: number, message: string): Response =>
  new Response(message, { status });

export const appOutboundFetch = async (
  request: Request,
  props: AppOutboundProps,
  deps: AppOutboundDeps
): Promise<Response> => {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  let approved: readonly string[];
  try {
    approved = await deps.grants.approvedHosts(props.versionId);
  } catch {
    // Fail closed: an app that cannot be checked gets no network.
    deps.log("app outbound: the approved hosts could not be read");
    return refuse(
      BAD_GATEWAY,
      "The platform could not check this app's hosts."
    );
  }
  const allowed = approved.some((entry) => entry.toLowerCase() === host);
  if (!allowed || url.protocol !== "https:") {
    return refuse(FORBIDDEN, "host not allowed");
  }
  return await outboundFetch(request, {
    announce: (announcedHost, names) =>
      deps.grants.announce(props, announcedHost, names),
    // A redirect goes back to the app, which asks again and so comes through
    // the allowlist again. Following one here would skip the host check.
    fetch: (outgoing) =>
      deps.fetch(new Request(outgoing, { redirect: "manual" })),
    log: deps.log,
    matches: (matchHost) => deps.grants.secretRules(props, matchHost),
  });
};
