// The `web_fetch` tool for a Pi isolate agent. With network access off the agent
// gets no tool and one prompt line, so it does not try to call a tool that is
// not there.
import { Type } from "@earendil-works/pi-ai";
import type {
  Extension,
  PromptSection,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { placeholderOf } from "@repo/services/secrets/placeholders";
import {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_TIMEOUT_MS,
  type WebFetcher,
  type WebFetchRequest,
  type WebFetchResult,
} from "./types.ts";

export const NETWORK_TOOLS_EXTENSION = "hm-network-tools";

const SECTION_KEY = "network-access";
const OFF_LINE =
  "Network access is off for this agent, so web_fetch and curl are not available.";
const PLACEHOLDER_SECTION_KEY = "secret-placeholders";
const PLACEHOLDER_LEAD =
  "Some secrets are available to you as placeholders. Write the placeholder text where the value belongs, in a web_fetch url, header value or text body, or in a curl command in the bash tool, where the variable $NAME holds the placeholder. The platform fills in the real value as the request leaves, and only for the hosts listed. You cannot read the real value.";

const MB = 1024 * 1024;

const parameters = Type.Object({
  body: Type.Optional(
    Type.String({
      description:
        "The request body. With bodyEncoding base64, the base64 of the bytes to send.",
    })
  ),
  bodyEncoding: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("base64")])
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  method: Type.Optional(
    Type.Union([
      Type.Literal("GET"),
      Type.Literal("HEAD"),
      Type.Literal("POST"),
      Type.Literal("PUT"),
      Type.Literal("PATCH"),
      Type.Literal("DELETE"),
      Type.Literal("OPTIONS"),
    ])
  ),
  responseEncoding: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("base64")], {
      description:
        "text decodes the answer as UTF-8. base64 returns the raw bytes, base64 encoded.",
    })
  ),
  url: Type.String(),
});

/** The request as the fetcher gets it. The signal lets a cancelled run stop the call. */
type FetchCall = WebFetchRequest & { signal?: AbortSignal };

/** Decodes base64 to bytes, or returns null when the text is not valid base64. */
const decodeBase64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const textResult = (text: string, isError: boolean) => ({
  isError,
  output: [{ text, type: "text" as const }],
});

const failure = (error: string, message: string) =>
  textResult(`web_fetch failed (${error}): ${message}`, true);

const webFetchTool = (
  fetcherOf: () => Promise<WebFetcher>
): ToolRegistration<typeof parameters> => ({
  description: `Sends an HTTP or HTTPS request from the platform. Only http and https URLs work. Private, loopback, link-local and internal addresses and this app's own hosts are refused. Redirects are followed, and each one is checked. Answers over ${WEB_FETCH_MAX_BYTES / MB} MB are refused. A call times out after ${WEB_FETCH_TIMEOUT_MS / 1000} seconds. Credentials the agent was granted for a host are added automatically. Text of the form hm-secret:NAME in the url, a header value or a text body is replaced by that secret's value when the host is one the secret allows. After a secret is filled in, a redirect is followed only within the same origin, and any other redirect is returned as the answer. A text answer is decoded as UTF-8. Set responseEncoding to base64 to get the raw bytes.`,
  execute: async (args, _api, context) => {
    let body: Uint8Array | undefined;
    if (args.body !== undefined) {
      if (args.bodyEncoding === "base64") {
        const decoded = decodeBase64(args.body);
        if (decoded === null) {
          return failure("bad_request", "body is not valid base64");
        }
        body = decoded;
      } else {
        body = new TextEncoder().encode(args.body);
      }
    }

    const request: FetchCall = {
      method: args.method ?? "GET",
      url: args.url,
      ...(args.headers === undefined ? {} : { headers: args.headers }),
      ...(body === undefined ? {} : { body }),
      ...(context.abortSignal === undefined
        ? {}
        : { signal: context.abortSignal }),
    };

    const result: WebFetchResult = await (await fetcherOf())(request);
    if (!result.ok) {
      return failure(result.error, result.message);
    }

    const encoding = args.responseEncoding ?? "text";
    const answer =
      encoding === "base64"
        ? encodeBase64(result.bytes)
        : new TextDecoder().decode(result.bytes);

    return textResult(
      JSON.stringify({
        body: answer,
        bytes: result.bytes.length,
        encoding,
        headers: result.headers,
        status: result.status,
        statusText: result.statusText,
        url: result.url,
      }),
      false
    );
  },
  name: "web_fetch",
  parameters,
  // A POST may not run twice, so an interrupted call is not replayed.
  replay: "unsafe",
});

/** A secret the agent may use as a placeholder, and the hosts it may be sent to. */
export interface SecretPlaceholder {
  hosts: readonly string[];
  name: string;
}

export interface NetworkToolsOptions {
  enabled: boolean;
  fetcherOf: () => Promise<WebFetcher>;
  /** Read when the prompt renders, so it lists the secrets granted at that time. */
  placeholdersOf?: () => Promise<readonly SecretPlaceholder[]>;
}

const placeholderLine = ({ hosts, name }: SecretPlaceholder): string => {
  const placeholder = `- ${name} (placeholder ${placeholderOf(name)}): `;
  return hosts.length === 0
    ? `${placeholder}no allowed hosts yet, so it cannot be used until someone adds them under Settings, Secrets`
    : `${placeholder}sent only to ${hosts.join(", ")}`;
};

const byName = (a: SecretPlaceholder, b: SecretPlaceholder): number => {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
};

/** Lists the placeholders, sorted by name. Renders nothing when there are none. */
const placeholderSection = (
  placeholdersOf: () => Promise<readonly SecretPlaceholder[]>
): PromptSection => ({
  key: PLACEHOLDER_SECTION_KEY,
  render: async () => {
    const placeholders = await placeholdersOf();
    if (placeholders.length === 0) {
      return;
    }
    const lines = [...placeholders].sort(byName).map(placeholderLine);
    return `${PLACEHOLDER_LEAD}\n\n${lines.join("\n")}`;
  },
});

/**
 * Installs `web_fetch` when network access is on, and the one-line notice when it is off.
 * With `placeholdersOf`, the on case also lists the secrets the agent may use as placeholders.
 */
export const networkToolsExtension = ({
  enabled,
  fetcherOf,
  placeholdersOf,
}: NetworkToolsOptions): Extension => {
  if (enabled) {
    return {
      name: NETWORK_TOOLS_EXTENSION,
      ...(placeholdersOf === undefined
        ? {}
        : { sections: [placeholderSection(placeholdersOf)] }),
      tools: [webFetchTool(fetcherOf)],
    };
  }
  return {
    name: NETWORK_TOOLS_EXTENSION,
    sections: [{ key: SECTION_KEY, render: () => OFF_LINE }],
    tools: [],
  };
};
