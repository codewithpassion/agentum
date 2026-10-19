// The `web_fetch` tool for a Pi isolate agent. With network access off the agent
// gets no tool and one prompt line, so it does not try to call a tool that is
// not there.
import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
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
  description: `Sends an HTTP or HTTPS request from the platform. Only http and https URLs work. Private, loopback, link-local and internal addresses and this app's own hosts are refused. Redirects are followed, and each one is checked. Answers over ${WEB_FETCH_MAX_BYTES / MB} MB are refused. A call times out after ${WEB_FETCH_TIMEOUT_MS / 1000} seconds. Credentials the agent was granted for a host are added automatically. A text answer is decoded as UTF-8. Set responseEncoding to base64 to get the raw bytes.`,
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

export interface NetworkToolsOptions {
  enabled: boolean;
  fetcherOf: () => Promise<WebFetcher>;
}

/** Installs `web_fetch` when network access is on, and the one-line notice when it is off. */
export const networkToolsExtension = ({
  enabled,
  fetcherOf,
}: NetworkToolsOptions): Extension => {
  if (enabled) {
    return { name: NETWORK_TOOLS_EXTENSION, tools: [webFetchTool(fetcherOf)] };
  }
  return {
    name: NETWORK_TOOLS_EXTENSION,
    sections: [{ key: SECTION_KEY, render: () => OFF_LINE }],
    tools: [],
  };
};
