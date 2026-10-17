/**
 * What an agent is told about its secrets, where it runs somewhere we cannot
 * intercept requests (a machine, a managed agent's sandbox). The text names
 * environment variables and relay URLs, never a value.
 */
import { RELAY_TOKEN_ENV, relayUrl } from "./relay.ts";
import { WILDCARD } from "./rules.ts";

export interface GuidedProxy {
  hosts: readonly string[];
  name: string;
}

const hostLine = (base: string, host: string): string =>
  host.startsWith(WILDCARD)
    ? `- ${host}: ${relayUrl(base, "<full-host>", "/<path>")}, with the complete host in place of <full-host>, for example a.${host.slice(WILDCARD.length)}`
    : `- ${host}: ${relayUrl(base, host, "/<path>")}`;

/**
 * The paragraphs for a run, or an empty string when it has no secrets.
 * Managed secrets arrive as placeholders that Anthropic swaps for the value on
 * the way out, so the text says so.
 */
export const secretsGuidance = ({
  base,
  env,
  proxy,
  surface,
}: {
  base: string;
  env: readonly string[];
  proxy: readonly GuidedProxy[];
  surface: "machine" | "managed";
}): string => {
  const paragraphs: string[] = [];
  if (env.length > 0) {
    paragraphs.push(
      surface === "managed"
        ? `These environment variables are set for you: ${env.join(", ")}. Each holds a placeholder, and the platform swaps in the real secret when a request that carries the variable in a header or body leaves your sandbox. Use it as $NAME in a request. You cannot read, print or decode the real value.`
        : `These environment variables are set for you: ${env.join(", ")}. Read them as $NAME, and never print them or write them into files or messages.`
    );
  }
  if (proxy.length > 0) {
    const hosts = [...new Set(proxy.flatMap((entry) => entry.hosts))].sort();
    paragraphs.push(
      [
        `Some APIs need a credential you do not hold. Send those requests to the Harbourmaster relay instead of to the API. The relay is the platform's own endpoint and is approved for this work. Keep the method, query and body, and add the header "Authorization: Bearer $${RELAY_TOKEN_ENV}". The relay adds the credential and forwards the request over HTTPS. A request sent straight to one of these hosts has no credential and fails. Relay addresses:`,
        ...hosts.map((host) => hostLine(base, host)),
      ].join("\n")
    );
  }
  return paragraphs.join("\n\n");
};
