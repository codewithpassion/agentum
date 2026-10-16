#!/usr/bin/env bun
/// <reference types="bun" />
// End-to-end check of MCP over Clerk OAuth, run the way an MCP client runs it,
// with a PRE-REGISTERED public OAuth application. Run from the repo root.
//
//   bun --env-file=apps/web/.env.local scripts/smoke-mcp-oauth.ts --create-client
//       Creates the public OAuth application "ZZ mcp oauth test" (redirect
//       http://127.0.0.1:8976/callback, the scopes /mcp advertises) with the
//       Clerk Backend API. Prints its client id and application id only.
//       Clerk creates a public application with pkce_required false and has no
//       option to change that; this script sends PKCE S256 on every flow anyway.
//   bun --env-file=apps/web/.env.local scripts/smoke-mcp-oauth.ts --base https://host --client-id <id>
//       GET /mcp -> 401 challenge -> protected resource metadata -> Clerk's
//       authorization server metadata -> authorize URL (PKCE S256), printed for
//       a signed-in browser ON THIS MACHINE to open and consent. Waits for the
//       redirect on 127.0.0.1:8976 and exchanges the code. The first MCP call
//       must be 403 client_not_approved: the script then says what to approve
//       (Settings > Connected apps, /settings/connected-apps) and polls every
//       3 s for up to 3 minutes. After approval it lists the tools over raw
//       JSON-RPC and checks that every tool in EXPECTED_TOOLS is there, and that
//       a tampered token gets 401 invalid_token.
//   bun --env-file=apps/web/.env.local scripts/smoke-mcp-oauth.ts --delete-client <application id>
//       Deletes that OAuth application.
//
// Never prints a token, code, verifier or secret: only timings, statuses, tool
// names and non-secret facts. Throws on the first failed check, so it exits 1.
import { parseArgs } from "node:util";
import { serve } from "bun";
import { OAUTH_SCOPES } from "../apps/web/src/server/mcp/metadata.ts";
import { runCli } from "./dev/local.ts";
import { EXPECTED_TOOLS, parseRpc } from "./smoke-mcp.ts";

const APP_NAME = "ZZ mcp oauth test";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 8976;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const CLERK_API = "https://api.clerk.com/v1";
const TRAILING_SLASHES = /\/+$/;
const RESOURCE_METADATA = /resource_metadata="([^"]+)"/;
const PKCE_BYTES = 32;
const USAGE =
  "Usage (run from the repo root):\n" +
  "  bun --env-file=apps/web/.env.local scripts/smoke-mcp-oauth.ts --create-client\n" +
  "  bun scripts/smoke-mcp-oauth.ts --base <url> --client-id <id>\n" +
  "  bun --env-file=apps/web/.env.local scripts/smoke-mcp-oauth.ts --delete-client <application id>";

type Json = Record<string, unknown>;

interface Discovered {
  authorizationEndpoint: string;
  issuer: string;
  scopes: string[];
  tokenEndpoint: string;
}

interface Probe {
  error: string | null;
  message: string | null;
  ms: number;
  status: number;
  tools: string[] | null;
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const check = (ok: boolean, label: string): void => {
  if (!ok) {
    throw new Error(`FAIL ${label}`);
  }
  say(`ok   ${label}`);
};

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `work` and reports how long it took. */
const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const result = await work();
  say(`     ${label}: ${Math.round(performance.now() - started)} ms`);
  return result;
};

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (document: Json, name: string): string => {
  const value = document[name];
  if (typeof value !== "string") {
    throw new Error(`the document has no string "${name}"`);
  }
  return value;
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const randomToken = (): string =>
  base64url(crypto.getRandomValues(new Uint8Array(PKCE_BYTES)));

const s256 = async (verifier: string): Promise<string> =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

/** A Clerk Backend API call. The secret key is only ever sent to Clerk. */
const clerkApi = async (
  method: "DELETE" | "POST",
  path: string,
  body?: Json
): Promise<unknown> => {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "CLERK_SECRET_KEY is not set. Run with --env-file=apps/web/.env.local."
    );
  }
  const response = await fetch(`${CLERK_API}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    method,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Clerk ${method} ${path} answered ${response.status}: ${text}`
    );
  }
  return text === "" ? {} : JSON.parse(text);
};

export const createClient = async (): Promise<void> => {
  const body = (await clerkApi("POST", "/oauth_applications", {
    name: APP_NAME,
    public: true,
    redirect_uris: [REDIRECT_URI],
    scopes: OAUTH_SCOPES.join(" "),
  })) as Json;
  say(`client id:      ${stringField(body, "client_id")}`);
  say(`application id: ${stringField(body, "id")}`);
  say(
    `public ${String(body.public)}, pkce required ${String(body.pkce_required)}, consent screen ${String(body.consent_screen_enabled)}, scopes "${String(body.scopes)}"`
  );
};

export const deleteClient = async (id: string): Promise<void> => {
  await clerkApi("DELETE", `/oauth_applications/${encodeURIComponent(id)}`);
  say(`deleted OAuth application ${id}`);
};

const getJson = async (url: string): Promise<Json> => {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const body: unknown = await response.json();
  if (!(response.ok && isRecord(body))) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return body;
};

/** Waits for Clerk's redirect to the loopback callback; resolves the code. */
const awaitCallback = (state: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.stop(true);
      reject(new Error("no callback within 5 minutes"));
    }, CONSENT_TIMEOUT_MS);
    const server = serve({
      fetch: (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname !== CALLBACK_PATH) {
          return new Response("Not found", { status: 404 });
        }
        clearTimeout(timer);
        setTimeout(() => server.stop(true), 100);
        // State first: a callback that is not ours is refused before its
        // error or code is even looked at.
        if (url.searchParams.get("state") !== state) {
          reject(new Error("state mismatch on the callback"));
          return new Response("State mismatch.", { status: 400 });
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error || !code) {
          reject(
            new Error(
              `authorization failed: ${error ?? "no code"} ${url.searchParams.get("error_description") ?? ""}`
            )
          );
          return new Response("Authorization failed. See the terminal.");
        }
        resolve(code);
        return new Response(
          "Harbourmaster MCP OAuth smoke: done, you can close this tab."
        );
      },
      hostname: CALLBACK_HOST,
      port: CALLBACK_PORT,
    });
  });

/** The client's discovery, from the 401 challenge to Clerk's metadata. */
const discover = async (endpoint: string): Promise<Discovered> => {
  const challenge = await timed("GET /mcp without a token", () =>
    fetch(endpoint, { headers: { Accept: "text/event-stream" } })
  );
  await challenge.body?.cancel();
  const header = challenge.headers.get("WWW-Authenticate") ?? "";
  say(`     WWW-Authenticate: ${header}`);
  check(challenge.status === 401, `401 (got ${challenge.status})`);
  check(!header.includes("error="), "bare challenge: no error attribute");
  const metadataUrl = RESOURCE_METADATA.exec(header)?.[1];
  check(Boolean(metadataUrl), "challenge names resource_metadata");

  const resource = await timed("protected resource metadata", () =>
    getJson(metadataUrl ?? "")
  );
  check(
    resource.resource === endpoint,
    `resource is ${endpoint} (got ${String(resource.resource)})`
  );
  const servers = resource.authorization_servers;
  const issuer = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof issuer !== "string") {
    throw new Error("no authorization_servers[0]");
  }
  const scopes = Array.isArray(resource.scopes_supported)
    ? resource.scopes_supported.filter(
        (scope): scope is string => typeof scope === "string"
      )
    : [];
  say(`     scopes_supported: ${scopes.join(" ")}`);

  const asMetadata = await timed("authorization server metadata (Clerk)", () =>
    getJson(`${issuer}/.well-known/oauth-authorization-server`)
  );
  check(asMetadata.issuer === issuer, "issuer echoes authorization_servers[0]");
  const methods = asMetadata.code_challenge_methods_supported;
  check(
    Array.isArray(methods) && methods.includes("S256"),
    "S256 PKCE supported"
  );
  say(
    `     registration_endpoint (DCR): ${"registration_endpoint" in asMetadata ? "present" : "absent"}`
  );
  const { origin } = new URL(endpoint);
  const proxied = await timed("proxied metadata on the MCP origin", () =>
    getJson(`${origin}/.well-known/oauth-authorization-server`)
  );
  check(proxied.issuer === issuer, "proxied document is Clerk's");
  return {
    authorizationEndpoint: stringField(asMetadata, "authorization_endpoint"),
    issuer,
    scopes,
    tokenEndpoint: stringField(asMetadata, "token_endpoint"),
  };
};

const exchange = async (
  discovered: Discovered,
  options: {
    clientId: string;
    code: string;
    resource: string;
    verifier: string;
  }
): Promise<string> => {
  const response = await timed("token exchange", () =>
    fetch(discovered.tokenEndpoint, {
      body: new URLSearchParams({
        client_id: options.clientId,
        code: options.code,
        code_verifier: options.verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        resource: options.resource,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    })
  );
  const body: unknown = await response.json();
  const document = isRecord(body) ? body : {};
  if (!response.ok || typeof document.access_token !== "string") {
    throw new Error(
      `token endpoint answered ${response.status}: ${String(document.error)} ${String(document.error_description ?? "")}`
    );
  }
  const token = document.access_token;
  const format = token.split(".").length === 3 ? "JWT" : "opaque";
  say(
    `     token_type ${String(document.token_type)}, expires_in ${String(document.expires_in)}, scope "${String(document.scope)}", refresh token ${typeof document.refresh_token === "string" ? "yes" : "no"}, format ${format}`
  );
  return token;
};

const rawToolsList = (endpoint: string, authorization: string) =>
  fetch(endpoint, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

/** The tool names in a tools/list result, or null when there is no result. */
const toolNames = (body: Json | null): string[] | null => {
  const result = body?.result;
  if (!(isRecord(result) && Array.isArray(result.tools))) {
    return null;
  }
  return result.tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []
  );
};

/** The JSON-RPC message in a response body, or null when it is not one. */
const parseBody = (contentType: string | null, text: string): Json | null => {
  try {
    const body = parseRpc(contentType, text);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
};

/** One raw tools/list: status, round trip, error code and tool names. */
const probe = async (endpoint: string, token: string): Promise<Probe> => {
  const started = performance.now();
  const response = await rawToolsList(endpoint, `Bearer ${token}`);
  const ms = Math.round(performance.now() - started);
  const body = parseBody(
    response.headers.get("content-type"),
    await response.text()
  );
  return {
    error: typeof body?.error === "string" ? body.error : null,
    message: typeof body?.message === "string" ? body.message : null,
    ms,
    status: response.status,
    tools: toolNames(body),
  };
};

/**
 * A fresh client is not approved yet: the first call must be 403
 * client_not_approved. Then polls until the owner approves it in Settings.
 */
const awaitApproval = async (
  endpoint: string,
  token: string
): Promise<void> => {
  const first = await probe(endpoint, token);
  say(`     first MCP call: ${first.ms} ms, status ${first.status}`);
  check(
    first.status === 403 && first.error === "client_not_approved",
    `first MCP call is 403 client_not_approved (got ${first.status} ${first.error ?? ""})`
  );
  say(`     message: ${first.message ?? "(none)"}`);
  say(
    `\nApprove "${APP_NAME}" under Harbourmaster > Settings > Connected apps (/settings/connected-apps). Polling every 3 s for up to 3 minutes...\n`
  );
  const deadline = performance.now() + APPROVAL_TIMEOUT_MS;
  const poll = async (): Promise<void> => {
    if (performance.now() >= deadline) {
      throw new Error(`"${APP_NAME}" was not approved within 3 minutes`);
    }
    await pause(POLL_INTERVAL_MS);
    const next = await probe(endpoint, token);
    if (next.status === 200) {
      say(`     approved: tools/list ${next.ms} ms`);
      return;
    }
    if (next.status !== 403) {
      throw new Error(
        `tools/list answered ${next.status} while waiting for approval`
      );
    }
    return poll();
  };
  await poll();
};

const exerciseToken = async (
  endpoint: string,
  token: string
): Promise<void> => {
  const listed = await timed("tools/list after approval", () =>
    probe(endpoint, token)
  );
  check(listed.status === 200, `tools/list answers 200 (got ${listed.status})`);
  const names = [...(listed.tools ?? [])].sort();
  say(`     tools (${names.length}): ${names.join(", ")}`);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  check(
    missing.length === 0,
    `every expected tool is listed${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`
  );

  const tampered = await timed("tools/list with a tampered token", () =>
    rawToolsList(endpoint, `Bearer ${token}x`)
  );
  await tampered.body?.cancel();
  check(
    tampered.status === 401 &&
      (tampered.headers.get("WWW-Authenticate") ?? "").includes(
        'error="invalid_token"'
      ),
    `tampered token -> 401 invalid_token (got ${tampered.status})`
  );
};

export const runFlow = async (
  baseUrl: string,
  clientId: string
): Promise<void> => {
  const endpoint = `${baseUrl}/mcp`;
  say(`MCP OAuth smoke test against ${endpoint}`);
  const discovered = await discover(endpoint);

  const verifier = randomToken();
  const state = randomToken();
  const authorize = new URL(discovered.authorizationEndpoint);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: endpoint,
    response_type: "code",
    scope: discovered.scopes.join(" "),
    state,
  }).toString();

  const callback = awaitCallback(state);
  say(
    `\nOpen this URL in a browser on this machine, signed in to Clerk, and consent:\n${authorize.href}\n`
  );
  const started = performance.now();
  const code = await callback;
  say(
    `     callback received after ${Math.round((performance.now() - started) / 1000)} s`
  );
  check(true, "authorization code received (state matched)");

  const token = await exchange(discovered, {
    clientId,
    code,
    resource: endpoint,
    verifier,
  });
  await awaitApproval(endpoint, token);
  await exerciseToken(endpoint, token);
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      "client-id": { type: "string" },
      "create-client": { type: "boolean" },
      "delete-client": { type: "string" },
    },
    strict: true,
  });
  if (values["create-client"]) {
    await createClient();
    return;
  }
  const deleteId = values["delete-client"];
  if (deleteId !== undefined) {
    await deleteClient(deleteId);
    return;
  }
  const { base, "client-id": clientId } = values;
  if (!(base && clientId)) {
    throw new Error(USAGE);
  }
  await runFlow(base.replace(TRAILING_SLASHES, ""), clientId);
  say("\nAll checks passed.");
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
