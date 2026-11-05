/**
 * What the platform does to a request that leaves an app's server part. The
 * Worker's `globalOutbound` is `AppOutbound`, which calls this. Only hosts a
 * person approved get through, read on every request because the loader
 * config is cached per version and approvals land after it loads. An allowed
 * request then goes through the same placeholder filling as `SecretsOutbound`.
 */

import type { AppGrantsPort } from "./ports.ts";
import { outboundFetch } from "./secrets-outbound-core.ts";
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
  const started = performance.now();
  const timings = { grants: 0, secretRules: 0, upstream: 0 };
  const timed = async <T>(
    stage: keyof typeof timings,
    run: () => Promise<T>
  ): Promise<T> => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      timings[stage] += performance.now() - start;
    }
  };
  try {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    let policy: Awaited<ReturnType<AppGrantsPort["read"]>>;
    try {
      policy = await timed("grants", () => deps.grants.read(props));
    } catch {
      // Fail closed: an app that cannot be checked gets no network.
      deps.log("app outbound: the approved hosts could not be read");
      return refuse(
        BAD_GATEWAY,
        "The platform could not check this app's hosts."
      );
    }
    const allowed = policy.hosts.some((entry) => entry.toLowerCase() === host);
    if (!allowed || url.protocol !== "https:") {
      return refuse(FORBIDDEN, "host not allowed");
    }
    return await outboundFetch(request, {
      announce: (announcedHost, names) =>
        deps.grants.announce(props, announcedHost, names),
      // A redirect goes back through the allowlist on the app's next fetch.
      fetch: (outgoing) =>
        timed("upstream", () =>
          deps.fetch(new Request(outgoing, { redirect: "manual" }))
        ),
      log: deps.log,
      matches: (matchHost) =>
        timed("secretRules", () => policy.secretRules(matchHost)),
    });
  } finally {
    console.log(
      "app outbound timing",
      JSON.stringify({
        grants: Math.round(timings.grants),
        secretRules: Math.round(timings.secretRules),
        total: Math.round(performance.now() - started),
        upstream: Math.round(timings.upstream),
      })
    );
  }
};
